// =============================================================================
// services/api.js
// The ONLY module in this project allowed to touch the network.
// Responsible for: initializing Firebase/Firestore, reading the search
// cache, calling the one backend endpoint (/api/search), and LRCLIB lyrics.
// app.js never imports fetch(), firebase, or firestore directly.
//
// The frontend never writes to Firestore and never builds a dynamic backend
// URL — every backend call is a plain, fixed fetch("/api/search?...").
// =============================================================================

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// -----------------------------------------------------------------------------
// Firebase configuration
// -----------------------------------------------------------------------------
// Replace with your own Firebase project's web config (Project settings ->
// General -> Your apps -> SDK setup and configuration). The client SDK here
// only ever performs reads (songs, search-cache); all writes happen inside
// the Vercel backend using firebase-admin + a service account, so these
// values never need write access in your Firestore security rules.
const firebaseConfig = {
  apiKey: "AIzaSyA2UJT5RD7CAcOJR6OTWfpkOEf8l2lhqlw",
  authDomain: "temporaryfileupload-92123.firebaseapp.com",
  projectId: "temporaryfileupload-92123",
  storageBucket: "temporaryfileupload-92123.firebasestorage.app",
  messagingSenderId: "1068057413521",
  appId: "1:1068057413521:web:d4c2ba30c6c12e57ddfc30"
};

let db = null;

/**
 * Initializes Firebase + Firestore. Safe to call multiple times — reuses the
 * existing app instance if one is already running.
 */
export function initFirebase() {
  if (db) return db;
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  db = getFirestore(app);
  return db;
}

function ensureDb() {
  return db || initFirebase();
}

function normalizeQuery(raw) {
  return (raw || "").toLowerCase().trim().replace(/\s+/g, " ");
}

function songDocToObject(id, data) {
  return {
    videoId: id,
    title: data.title || "Untitled",
    artist: data.artist || "Unknown artist",
    album: data.album || "",
    duration: typeof data.duration === "number" ? data.duration : 0,
    thumbnail: data.thumbnail || "",
  };
}

// -----------------------------------------------------------------------------
// Songs collection reads
// -----------------------------------------------------------------------------

/**
 * Loads song metadata for a list of videoIds from Firestore's `songs`
 * collection, preserving input order. Ids without a matching document are
 * skipped — metadata is written server-side the first time a search surfaces
 * a track, so a missing doc means the id never resolved to a real result.
 */
export async function getSongsByIds(videoIds) {
  const database = ensureDb();
  const unique = [...new Set((videoIds || []).filter(Boolean))];
  const found = new Map();

  await Promise.all(
    unique.map(async (id) => {
      try {
        const snap = await getDoc(doc(database, "songs", id));
        if (snap.exists()) found.set(id, songDocToObject(id, snap.data()));
      } catch {
        // A single failed lookup shouldn't fail the whole batch.
      }
    })
  );

  return (videoIds || []).filter((id) => found.has(id)).map((id) => found.get(id));
}

// -----------------------------------------------------------------------------
// Search
// -----------------------------------------------------------------------------

/**
 * Search flow:
 *  1. Normalize the query.
 *  2. Check Firestore `search-cache` for a matching document (read-only).
 *  3. On a hit, resolve song metadata straight from Firestore — no backend call.
 *  4. On a miss, call GET /api/search?q=<query>. The backend calls the
 *     YouTube Data API, writes `songs` + `search-cache`, and returns the
 *     resolved songs directly. The caller never learns which path was taken.
 */
export async function searchSongs(rawQuery) {
  const normalized = normalizeQuery(rawQuery);
  if (!normalized) return [];

  const database = ensureDb();

  try {
    const cacheSnap = await getDoc(doc(database, "search-cache", normalized));
    if (cacheSnap.exists()) {
      const videoIds = cacheSnap.data().videoIds || [];
      const songs = await getSongsByIds(videoIds);
      if (songs.length > 0) return songs;
    }
  } catch {
    // Firestore unreachable — fall through to the backend.
  }

  const response = await fetch(`/api/search?q=${encodeURIComponent(normalized)}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Search failed with status ${response.status}`);
  }
  const payload = await response.json();
  return Array.isArray(payload.songs) ? payload.songs : [];
}

// -----------------------------------------------------------------------------
// Lyrics (LRCLIB)
// -----------------------------------------------------------------------------

/** Parses standard LRC-format synced lyrics into [{ time, text }]. */
function parseLrc(lrcText) {
  const lines = lrcText.split("\n");
  const timeTag = /\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
  const out = [];

  for (const line of lines) {
    const matches = [...line.matchAll(timeTag)];
    if (matches.length === 0) continue;
    const text = line.replace(timeTag, "").trim();
    for (const m of matches) {
      const minutes = parseInt(m[1], 10);
      const seconds = parseInt(m[2], 10);
      const millis = m[3] ? parseInt(m[3].padEnd(3, "0"), 10) : 0;
      out.push({ time: minutes * 60 + seconds + millis / 1000, text });
    }
  }

  return out.sort((a, b) => a.time - b.time);
}

/**
 * Fetches lyrics from LRCLIB for a given song. Returns
 * { synced: [{time,text}]|null, plain: string|null } or null if unavailable.
 */
export async function fetchLyrics({ title, artist, duration }) {
  const getParams = new URLSearchParams({ track_name: title || "", artist_name: artist || "" });
  if (duration) getParams.set("duration", String(Math.round(duration)));

  try {
    const response = await fetch(`https://lrclib.net/api/get?${getParams.toString()}`, {
      headers: { Accept: "application/json" },
    });
    if (response.ok) {
      const data = await response.json();
      const synced = data.syncedLyrics ? parseLrc(data.syncedLyrics) : null;
      const plain = data.plainLyrics || null;
      if (synced || plain) return { synced, plain };
    }
  } catch {
    // fall through to the search-based fallback below
  }

  try {
    const searchParams = new URLSearchParams({ track_name: title || "", artist_name: artist || "" });
    const response = await fetch(`https://lrclib.net/api/search?${searchParams.toString()}`, {
      headers: { Accept: "application/json" },
    });
    if (response.ok) {
      const results = await response.json();
      if (Array.isArray(results) && results.length > 0) {
        const best = results[0];
        const synced = best.syncedLyrics ? parseLrc(best.syncedLyrics) : null;
        const plain = best.plainLyrics || null;
        if (synced || plain) return { synced, plain };
      }
    }
  } catch {
    // no lyrics available anywhere for this track
  }

  return null;
}
