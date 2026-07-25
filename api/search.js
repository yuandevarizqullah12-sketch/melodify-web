// =============================================================================
// api/search.js — Vercel Serverless Function
// GET /api/search?q=<query>
//
// The ONLY place YouTube's Data API key is used. The frontend never sees it.
// Flow: normalize -> Firestore search-cache lookup -> on miss, call the
// YouTube Data API, write `songs` + `search-cache`, return resolved songs.
// =============================================================================

import admin from "firebase-admin";

const MAX_QUERY_LENGTH = 100;
const MAX_RESULTS = 20;

// -----------------------------------------------------------------------------
// Firebase Admin (idempotent — Vercel may reuse this module across invocations
// on a warm lambda, so we must not call initializeApp() more than once).
// -----------------------------------------------------------------------------
function getDb() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
      }),
    });
  }
  return admin.firestore();
}

function normalize(raw) {
  return (raw || "").toString().toLowerCase().trim().replace(/\s+/g, " ").slice(0, MAX_QUERY_LENGTH);
}

function parseIsoDurationToSeconds(iso) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!match) return 0;
  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const seconds = parseInt(match[3] || "0", 10);
  return hours * 3600 + minutes * 60 + seconds;
}

function pickThumbnail(thumbnails) {
  if (!thumbnails) return "";
  return (thumbnails.medium || thumbnails.high || thumbnails.default || {}).url || "";
}

async function loadSongsByIds(db, videoIds) {
  const results = [];
  for (const id of videoIds) {
    try {
      const snap = await db.collection("songs").doc(id).get();
      if (snap.exists) {
        const data = snap.data();
        results.push({
          videoId: id,
          title: data.title || "Untitled",
          artist: data.artist || "Unknown artist",
          album: data.album || "",
          duration: typeof data.duration === "number" ? data.duration : 0,
          thumbnail: data.thumbnail || "",
        });
      }
    } catch {
      // Skip a single failed lookup rather than failing the whole batch.
    }
  }
  return results;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const rawQuery = Array.isArray(req.query.q) ? req.query.q[0] : req.query.q;
  const normalized = normalize(rawQuery);
  if (!normalized) {
    res.status(400).json({ error: 'Missing required query parameter "q"' });
    return;
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server misconfigured: YOUTUBE_API_KEY is not set" });
    return;
  }

  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error("Firebase Admin init failed:", err);
    res.status(500).json({ error: "Server misconfigured: Firebase Admin credentials are invalid" });
    return;
  }

  // 1. Cache check — a concurrent request may have already resolved this
  //    exact query since the client checked; save a YouTube quota call.
  try {
    const cacheSnap = await db.collection("search-cache").doc(normalized).get();
    if (cacheSnap.exists) {
      const cachedIds = cacheSnap.data().videoIds || [];
      const cachedSongs = await loadSongsByIds(db, cachedIds);
      if (cachedSongs.length > 0) {
        res.status(200).json({ songs: cachedSongs, cached: true });
        return;
      }
    }
  } catch (err) {
    console.error("Firestore cache read failed:", err);
    // Non-fatal — fall through to a live YouTube search.
  }

  // 2. Cache miss — call the YouTube Data API.
  try {
    const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
    searchUrl.searchParams.set("part", "snippet");
    searchUrl.searchParams.set("type", "video");
    searchUrl.searchParams.set("videoCategoryId", "10"); // Music
    searchUrl.searchParams.set("maxResults", String(MAX_RESULTS));
    searchUrl.searchParams.set("q", normalized);
    searchUrl.searchParams.set("key", apiKey);

    const searchResp = await fetch(searchUrl.toString());
    if (!searchResp.ok) {
      throw new Error(`YouTube search request failed with status ${searchResp.status}`);
    }
    const searchData = await searchResp.json();
    const videoIds = (searchData.items || []).map((item) => item.id && item.id.videoId).filter(Boolean);

    if (videoIds.length === 0) {
      res.status(200).json({ songs: [], cached: false });
      return;
    }

    const detailsUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
    detailsUrl.searchParams.set("part", "snippet,contentDetails");
    detailsUrl.searchParams.set("id", videoIds.join(","));
    detailsUrl.searchParams.set("key", apiKey);

    const detailsResp = await fetch(detailsUrl.toString());
    if (!detailsResp.ok) {
      throw new Error(`YouTube videos request failed with status ${detailsResp.status}`);
    }
    const detailsData = await detailsResp.json();

    const songs = [];
    const batch = db.batch();

    for (const item of detailsData.items || []) {
      const title = item.snippet.title || "Untitled";
      const artist = item.snippet.channelTitle || "Unknown artist";
      const thumbnail = pickThumbnail(item.snippet.thumbnails);
      const duration = parseIsoDurationToSeconds(item.contentDetails.duration);

      songs.push({ videoId: item.id, title, artist, album: "", duration, thumbnail });

      batch.set(
        db.collection("songs").doc(item.id),
        {
          videoId: item.id,
          title,
          artist,
          album: "",
          duration,
          thumbnail,
          titleLower: title.toLowerCase(),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    batch.set(db.collection("search-cache").doc(normalized), {
      query: normalized,
      videoIds: songs.map((s) => s.videoId),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    res.status(200).json({ songs, cached: false });
  } catch (err) {
    console.error("Search failed:", err);
    res.status(502).json({ error: "Search failed", detail: String((err && err.message) || err) });
  }
}
