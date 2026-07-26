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
  apiKey: "AIzaSyA2UJT5RD7CAcOJR6OTWfpkOEf8l2lhqlw",
  authDomain: "temporaryfileupload-92123.firebaseapp.com",
  projectId: "temporaryfileupload-92123",
  storageBucket: "temporaryfileupload-92123.firebasestorage.app",
  messagingSenderId: "1068057413521",
  appId: "1:1068057413521:web:d4c2ba30c6c12e57ddfc30"
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
// Flow: memory cache -> Firestore lyrics cache -> LRCLIB -> save
// -------------------------------------------------------------

/**
 * Fetch lyrics (synced + plain) for a song.
 * @param {{id: string, title: string, artist: string}} song
 * @returns {Promise<{synced: Array<{time:number,text:string}>|null, plain: string|null}>}
 */
export async function fetchLyrics(song) {
  const { id, title, artist } = song;

  if (memoryCache.lyrics.has(id)) {
    return memoryCache.lyrics.get(id);
  }

  const firestore = getDb();

  // 1. Firestore lyrics cache
  try {
    const snap = await getDoc(doc(firestore, "lyrics", id));
    if (snap.exists()) {
      const data = snap.data();
      const result = { synced: data.synced || null, plain: data.plain || null };
      memoryCache.lyrics.set(id, result);
      return result;
    }
  } catch (err) {
    console.warn("fetchLyrics: Firestore read failed", err);
  }

  // 2. LRCLIB
  let result = { synced: null, plain: null };
  try {
    const url = `https://lrclib.net/api/search?track_name=${encodeURIComponent(
      title
    )}&artist_name=${encodeURIComponent(artist)}`;
    const res = await fetch(url);
    if (res.ok) {
      const matches = await res.json();
      const best = Array.isArray(matches) && matches.length ? matches[0] : null;
      if (best) {
        result = {
          synced: best.syncedLyrics ? parseLrc(best.syncedLyrics) : null,
          plain: best.plainLyrics || null,
        };
      }
    }
  } catch (err) {
    console.warn("fetchLyrics: LRCLIB request failed", err);
  }

  memoryCache.lyrics.set(id, result);

  // 3. Save cache (fire and forget)
  setDoc(doc(firestore, "lyrics", id), {
    ...result,
    cachedAt: serverTimestamp(),
  }).catch((err) => console.warn("fetchLyrics: Firestore write failed", err));

  return result;
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