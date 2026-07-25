// =============================================================================
// api/suggest.js — Vercel Serverless Function
// GET /api/suggest?q=<partial query>
//
// Autocomplete suggestions, cache-only: reads titles already cached in the
// `songs` collection (written by api/search.js) and returns up to six
// prefix matches. This endpoint never calls the YouTube Data API — it only
// exists as the fallback for services/api.js when the client's own Firestore
// read comes back empty (e.g. restrictive security rules, offline cache).
// =============================================================================

import admin from "firebase-admin";

const MAX_QUERY_LENGTH = 100;
const MAX_SUGGESTIONS = 6;

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
    res.status(200).json({ suggestions: [] });
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

  try {
    const snap = await db
      .collection("songs")
      .orderBy("titleLower")
      .where("titleLower", ">=", normalized)
      .where("titleLower", "<=", normalized + "\uf8ff")
      .limit(MAX_SUGGESTIONS)
      .get();

    const suggestions = snap.docs.map((docSnap) => {
      const data = docSnap.data();
      return { label: `${data.title} — ${data.artist}`, query: data.title };
    });

    res.status(200).json({ suggestions });
  } catch (err) {
    console.error("Suggest failed:", err);
    res.status(200).json({ suggestions: [] });
  }
}
