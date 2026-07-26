// =============================================================
// Melodify — api/search.js
// Vercel Serverless Function. Backend logic only.
// Flow: Firestore search cache -> YouTube Data API -> normalize
//       -> save song docs -> save search cache -> return songs
//
// Required environment variables (set in Vercel project settings,
// never committed to the repo):
//   YOUTUBE_API_KEY
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY   (with literal \n line breaks)
// =============================================================

import crypto from "node:crypto";

const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEARCH_CACHE_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

let cachedAccessToken = null;
let cachedAccessTokenExpiry = 0;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const query = normalizeQuery(req.query.q || "");
  if (!query) {
    res.status(400).json({ error: "Missing query parameter 'q'" });
    return;
  }

  try {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const token = await getAccessToken();

    // 1. Firestore search cache
    const cacheKey = encodeURIComponent(query);
    const cached = await firestoreGetDoc(projectId, token, `searchCache/${cacheKey}`);

    if (cached && isFresh(cached.fields, SEARCH_CACHE_TTL_MS)) {
      const ids = (cached.fields.songIds?.arrayValue?.values || []).map(
        (v) => v.stringValue
      );
      const songs = await fetchSongsByIds(projectId, token, ids);
      if (songs.length) {
        res.status(200).json({ songs, source: "cache" });
        return;
      }
    }

    // 2. YouTube Data API
    const rawResults = await searchYouTube(query);
    const songs = rawResults.map(normalizeYoutubeItem);

    // 3. Save song documents + 4. Save search cache (best-effort, parallel)
    await Promise.all([
      ...songs.map((song) => firestoreSetDoc(projectId, token, `songs/${song.id}`, songToFields(song))),
      firestoreSetDoc(projectId, token, `searchCache/${cacheKey}`, {
        query: { stringValue: query },
        songIds: {
          arrayValue: { values: songs.map((s) => ({ stringValue: s.id })) },
        },
        cachedAt: { timestampValue: new Date().toISOString() },
      }),
    ]).catch((err) => console.warn("Cache write failed", err));

    res.status(200).json({ songs, source: "youtube" });
  } catch (err) {
    console.error("search.js error", err);
    res.status(502).json({ error: "Search failed", detail: err.message });
  }
}

function normalizeQuery(q) {
  return String(q).trim().toLowerCase().replace(/\s+/g, " ");
}

function isFresh(fields, ttlMs) {
  const ts = fields?.cachedAt?.timestampValue;
  if (!ts) return false;
  return Date.now() - new Date(ts).getTime() < ttlMs;
}

// -------------------------------------------------------------
// YouTube Data API
// -------------------------------------------------------------
async function searchYouTube(query) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("videoCategoryId", "10"); // Music
  url.searchParams.set("maxResults", "20");
  url.searchParams.set("q", query);
  url.searchParams.set("key", apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`YouTube API error: ${res.status}`);
  }
  const data = await res.json();
  return data.items || [];
}

function normalizeYoutubeItem(item) {
  const snippet = item.snippet || {};
  const id = item.id?.videoId;
  const title = decodeHtml(snippet.title || "Unknown title");
  const channelTitle = decodeHtml(snippet.channelTitle || "Unknown artist");
  const { title: parsedTitle, artist } = splitTitleArtist(title, channelTitle);

  return {
    id,
    title: parsedTitle,
    artist,
    thumbnail:
      snippet.thumbnails?.high?.url ||
      snippet.thumbnails?.medium?.url ||
      snippet.thumbnails?.default?.url ||
      "",
    channelTitle,
    publishedAt: snippet.publishedAt || null,
  };
}

function splitTitleArtist(title, channelTitle) {
  const separators = [" - ", " – ", " — ", "|"];
  for (const sep of separators) {
    if (title.includes(sep)) {
      const [a, b] = title.split(sep);
      return { artist: a.trim(), title: b.trim() };
    }
  }
  return { title, artist: channelTitle.replace(/\s*-\s*Topic$/i, "") };
}

function decodeHtml(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// -------------------------------------------------------------
// Firestore REST helpers (no external dependencies)
// -------------------------------------------------------------
function songToFields(song) {
  return {
    title: { stringValue: song.title },
    artist: { stringValue: song.artist },
    thumbnail: { stringValue: song.thumbnail },
    channelTitle: { stringValue: song.channelTitle },
    cachedAt: { timestampValue: new Date().toISOString() },
  };
}

function fieldsToSong(id, fields) {
  return {
    id,
    title: fields.title?.stringValue || "Unknown title",
    artist: fields.artist?.stringValue || "Unknown artist",
    thumbnail: fields.thumbnail?.stringValue || "",
    channelTitle: fields.channelTitle?.stringValue || "",
  };
}

async function fetchSongsByIds(projectId, token, ids) {
  const docs = await Promise.all(
    ids.map((id) => firestoreGetDoc(projectId, token, `songs/${id}`))
  );
  return docs
    .map((d, i) => (d ? fieldsToSong(ids[i], d.fields) : null))
    .filter(Boolean);
}

async function firestoreGetDoc(projectId, token, path) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.json();
}

async function firestoreSetDoc(projectId, token, path, fields) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Firestore write failed: ${res.status} ${text}`);
  }
  return res.json();
}

// -------------------------------------------------------------
// Google service-account OAuth2 (signed JWT -> access token)
// -------------------------------------------------------------
async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiry - 60_000) {
    return cachedAccessToken;
  }

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: clientEmail,
    scope: FIRESTORE_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKey);
  const jwt = `${unsigned}.${base64url(signature)}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OAuth token exchange failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  cachedAccessToken = data.access_token;
  cachedAccessTokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedAccessToken;
}

function base64url(input) {
  const buffer = typeof input === "string" ? Buffer.from(input) : input;
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}