// =============================================================
// Melodify — services/api.js
// Firebase init, Firestore access, memory cache, and all network
// communication. NO UI code / NO DOM manipulation lives here.
// =============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// -------------------------------------------------------------
// Firebase initialization
// Replace with your own project's public web config. Firebase
// web config values are not secret — access is controlled by
// Firestore Security Rules, not by hiding this object.
// -------------------------------------------------------------
const firebaseConfig = {
  apiKey: "YOUR_FIREBASE_API_KEY",
  authDomain: "melodify-app.firebaseapp.com",
  projectId: "melodify-app",
  storageBucket: "melodify-app.appspot.com",
  messagingSenderId: "000000000000",
  appId: "YOUR_FIREBASE_APP_ID",
};

let app = null;
let db = null;

function getDb() {
  if (!db) {
    app = initializeApp(firebaseConfig);
    db = getFirestore(app);
  }
  return db;
}

// -------------------------------------------------------------
// In-memory cache (fastest layer, cleared on page reload)
// -------------------------------------------------------------
const memoryCache = {
  searches: new Map(), // normalizedQuery -> Song[]
  songs: new Map(), // songId -> Song
  lyrics: new Map(), // songId -> Lyrics
};

function normalizeQuery(query) {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

// -------------------------------------------------------------
// Song cache helpers
// -------------------------------------------------------------

/**
 * Store songs in the memory cache, keyed by id.
 * @param {Array<Object>} songs
 */
export function cacheSongs(songs) {
  for (const song of songs) {
    memoryCache.songs.set(song.id, song);
  }
  return songs;
}

/**
 * Resolve a list of song ids to full song objects, checking the
 * memory cache first, then Firestore's `songs` collection.
 * Used to hydrate playlists/favorites that only store ids.
 * @param {string[]} ids
 * @returns {Promise<Array<Object>>}
 */
export async function resolveSongs(ids) {
  const results = [];
  const missing = [];

  for (const id of ids) {
    const cached = memoryCache.songs.get(id);
    if (cached) {
      results.push(cached);
    } else {
      missing.push(id);
    }
  }

  if (missing.length === 0) return results;

  const firestore = getDb();
  const fetched = await Promise.all(
    missing.map(async (id) => {
      try {
        const snap = await getDoc(doc(firestore, "songs", id));
        return snap.exists() ? { id, ...snap.data() } : null;
      } catch (err) {
        console.warn("resolveSongs: failed to fetch song", id, err);
        return null;
      }
    })
  );

  const resolved = fetched.filter(Boolean);
  cacheSongs(resolved);
  return [...results, ...resolved];
}

// -------------------------------------------------------------
// Search
// Flow: memory cache -> Firestore search cache -> YouTube API
// (the Firestore + YouTube steps happen server-side in
// /api/search.js so the API key is never exposed to the client)
// -------------------------------------------------------------

/**
 * Search for songs by query string.
 * @param {string} query
 * @returns {Promise<Array<Object>>}
 */
export async function searchSongs(query) {
  const key = normalizeQuery(query);
  if (!key) return [];

  if (memoryCache.searches.has(key)) {
    return memoryCache.searches.get(key);
  }

  const response = await fetch(`/api/search?q=${encodeURIComponent(key)}`);
  if (!response.ok) {
    const message = await response.text().catch(() => "Search failed");
    throw new Error(message || `Search failed with status ${response.status}`);
  }

  const data = await response.json();
  const songs = Array.isArray(data.songs) ? data.songs : [];

  cacheSongs(songs);
  memoryCache.searches.set(key, songs);
  return songs;
}

// -------------------------------------------------------------
// Lyrics
// Flow: memory cache -> Firestore lyrics cache -> LRCLIB (multi
// strategy + fuzzy matching) -> save cache (success or failure)
// -------------------------------------------------------------

const NOT_FOUND = { synced: null, plain: null, notFound: true };

/**
 * Fetch lyrics (synced + plain) for a song. Uses the song title,
 * artist, and duration to find and score the closest LRCLIB match.
 * @param {{id: string, title: string, artist: string, durationSeconds?: number}} song
 * @returns {Promise<{synced: Array<{time:number,text:string}>|null, plain: string|null}>}
 */
export async function fetchLyrics(song) {
  const { id, title, artist, durationSeconds } = song;

  if (memoryCache.lyrics.has(id)) {
    return stripInternal(memoryCache.lyrics.get(id));
  }

  const firestore = getDb();

  // 1. Firestore lyrics cache (covers both successful and
  // previously-failed lookups, so we never repeat a dead search)
  try {
    const snap = await getDoc(doc(firestore, "lyrics", id));
    if (snap.exists()) {
      const data = snap.data();
      const result = data.notFound
        ? NOT_FOUND
        : { synced: data.synced || null, plain: data.plain || null };
      memoryCache.lyrics.set(id, result);
      return stripInternal(result);
    }
  } catch (err) {
    console.warn("fetchLyrics: Firestore read failed", err);
  }

  // 2. LRCLIB — try multiple normalized search strategies until a
  // confident match is found, then rank candidates by similarity.
  const clean = normalizeForLyrics(title, artist);
  const strategies = buildSearchStrategies(clean);

  let best = null;
  let bestScore = 0;

  for (const strategy of strategies) {
    const candidates = await searchLrclib(strategy);
    for (const candidate of candidates) {
      const score = scoreCandidate(candidate, clean, durationSeconds);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    // Confident enough match — no need to try further strategies.
    if (bestScore >= 0.82) break;
  }

  const MATCH_THRESHOLD = 0.55;
  let result;
  if (best && bestScore >= MATCH_THRESHOLD) {
    result = {
      synced: best.syncedLyrics ? parseLrc(best.syncedLyrics) : null,
      plain: best.plainLyrics || null,
    };
  } else {
    result = { ...NOT_FOUND };
  }

  memoryCache.lyrics.set(id, result);

  // 3. Save cache (fire and forget) — failures are cached too, with
  // a `notFound` flag, so we never re-run this search for this song.
  const cachePayload = result.notFound
    ? { notFound: true, synced: null, plain: null, cachedAt: serverTimestamp() }
    : { ...result, notFound: false, cachedAt: serverTimestamp() };

  setDoc(doc(firestore, "lyrics", id), cachePayload).catch((err) =>
    console.warn("fetchLyrics: Firestore write failed", err)
  );

  return stripInternal(result);
}

function stripInternal(result) {
  return { synced: result.synced || null, plain: result.plain || null };
}

// -------------------------------------------------------------
// Title / artist normalization
// -------------------------------------------------------------

const NOISE_PATTERNS = [
  /\(?\[?official\s*(music\s*)?video\)?\]?/gi,
  /\(?\[?official\s*audio\)?\]?/gi,
  /\(?\[?official\s*lyric[s]?\s*video\)?\]?/gi,
  /\(?\[?lyric[s]?\s*video\)?\]?/gi,
  /\(?\[?lyrics?\)?\]?/gi,
  /\(?\[?audio\)?\]?/gi,
  /\(?\[?visualizer\)?\]?/gi,
  /\(?\[?video\)?\]?/gi,
  /\(?\[?hd\)?\]?/gi,
  /\(?\[?4k\)?\]?/gi,
  /\(?\[?m\/?v\)?\]?/gi,
  /\(?\[?explicit\)?\]?/gi,
  /\(?\[?clean\)?\]?/gi,
  /\(?\[?remastered?(\s*\d{4})?\)?\]?/gi,
  /\(?\[?prod\.?\s*by\s*[^)\]]*\)?\]?/gi,
  /\s*-\s*topic$/gi,
  /\bft\.?\s.+$/gi,
  /\bfeat\.?\s.+$/gi,
];

/**
 * Strip noise like "(Official Video)", "[HD]", "Lyrics" etc, and
 * lowercase/trim the title and artist for matching purposes.
 */
function normalizeForLyrics(title, artist) {
  let t = title || "";
  let a = artist || "";
  for (const pattern of NOISE_PATTERNS) {
    t = t.replace(pattern, " ");
    a = a.replace(pattern, " ");
  }
  const squash = (s) =>
    s
      .replace(/[_]+/g, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  return { title: squash(t), artist: squash(a) };
}

/**
 * Build an ordered list of search strategies to try against LRCLIB.
 * Each is tried in turn until a confident match is found.
 */
function buildSearchStrategies(clean) {
  const strategies = [];
  if (clean.title && clean.artist) {
    strategies.push({ track_name: clean.title, artist_name: clean.artist });
    strategies.push({ track_name: `${clean.artist} ${clean.title}` });
  }
  if (clean.title) {
    strategies.push({ track_name: clean.title });
  }
  if (clean.artist) {
    strategies.push({ track_name: clean.artist });
  }
  return strategies;
}

async function searchLrclib(params) {
  try {
    const query = new URLSearchParams(params);
    const res = await fetch(`https://lrclib.net/api/search?${query.toString()}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn("fetchLyrics: LRCLIB request failed", err);
    return [];
  }
}

/**
 * Score a LRCLIB candidate against the normalized query using
 * title/artist similarity plus duration closeness.
 */
function scoreCandidate(candidate, clean, durationSeconds) {
  const candTitle = squashPlain(candidate.trackName || "");
  const candArtist = squashPlain(candidate.artistName || "");

  const titleScore = clean.title ? similarity(candTitle, clean.title) : 0.5;
  const artistScore = clean.artist ? similarity(candArtist, clean.artist) : 0.5;

  let durationScore = 0.5;
  if (durationSeconds && candidate.duration) {
    const diff = Math.abs(candidate.duration - durationSeconds);
    durationScore = diff <= 2 ? 1 : diff <= 5 ? 0.85 : diff <= 10 ? 0.6 : diff <= 20 ? 0.3 : 0;
  }

  return titleScore * 0.5 + artistScore * 0.3 + durationScore * 0.2;
}

function squashPlain(s) {
  return s
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Fuzzy string similarity using Sørensen–Dice bigram coefficient.
 * Returns a value between 0 (no match) and 1 (identical).
 */
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bigrams = (s) => {
    const out = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };
  const bigramsA = bigrams(a);
  const bigramsB = bigrams(b);
  if (!bigramsA.length || !bigramsB.length) return a.includes(b) || b.includes(a) ? 0.7 : 0;

  const counts = new Map();
  for (const bg of bigramsA) counts.set(bg, (counts.get(bg) || 0) + 1);

  let overlap = 0;
  for (const bg of bigramsB) {
    const count = counts.get(bg) || 0;
    if (count > 0) {
      overlap++;
      counts.set(bg, count - 1);
    }
  }
  return (2 * overlap) / (bigramsA.length + bigramsB.length);
}

/**
 * Parse standard LRC synced-lyrics format into [{time, text}].
 * @param {string} lrc
 */
function parseLrc(lrc) {
  const lines = lrc.split("\n");
  const parsed = [];
  const timeTag = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]/g;

  for (const line of lines) {
    const tags = [...line.matchAll(timeTag)];
    if (!tags.length) continue;
    const text = line.replace(timeTag, "").trim();
    for (const tag of tags) {
      const minutes = parseInt(tag[1], 10);
      const seconds = parseInt(tag[2], 10);
      const millis = tag[3] ? parseInt(tag[3].padEnd(3, "0"), 10) : 0;
      const time = minutes * 60 + seconds + millis / 1000;
      parsed.push({ time, text });
    }
  }

  return parsed.sort((a, b) => a.time - b.time);
}