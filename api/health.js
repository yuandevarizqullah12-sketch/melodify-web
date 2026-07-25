// =============================================================================
// api/health.js — Vercel Serverless Function
// GET /api/health
//
// Simple liveness check for the backend deployment. Does not touch Firebase
// or YouTube, so it stays fast and has nothing external to fail.
// =============================================================================

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  res.status(200).json({ status: "ok" });
}
