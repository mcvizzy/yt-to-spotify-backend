// server.js
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

app.use(cors());
app.use(express.json());

// ---------- Helpers ----------

// Get YouTube title via oEmbed (no API key needed)
async function getYoutubeTitle(youtubeUrl) {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      youtubeUrl
    )}&format=json`;

    const { data } = await axios.get(oembedUrl);
    return data.title; // e.g., "Artist - Song (Official Video)"
  } catch (err) {
    console.error("Error fetching YouTube title:", err.message);
    return null;
  }
}

// Clean title: remove brackets, "official video", etc.
function cleanTitle(rawTitle) {
  if (!rawTitle) return "";

  let title = rawTitle;

  // Remove things in parentheses or brackets: (Official Video), [Lyric Video], etc.
  title = title.replace(/\(.*?\)/g, "");
  title = title.replace(/\[.*?]/g, "");

  // Remove common noise words
  const noisePatterns = [
    /official\s*video/gi,
    /official\s*music\s*video/gi,
    /lyrics?/gi,
    /audio/gi,
    /hd/gi,
    /4k/gi,
    /remastered/gi,
  ];
  noisePatterns.forEach((re) => {
    title = title.replace(re, "");
  });

  // Collapse extra spaces
  title = title.replace(/\s+/g, " ").trim();

  return title;
}

// Normalize strings for comparison
function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, "") // apostrophes
    .replace(/[^\w\s]/g, "") // punctuation
    .replace(/\s+/g, " ")
    .trim();
}

// Get Spotify access token via Client Credentials flow
async function getSpotifyAccessToken() {
  const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } = process.env;

  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    console.error("Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET env vars.");
    return null;
  }

  const tokenUrl = "https://accounts.spotify.com/api/token";
  const authHeader = Buffer.from(
    `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");

  try {
    const { data } = await axios.post(
      tokenUrl,
      "grant_type=client_credentials",
      {
        headers: {
          Authorization: `Basic ${authHeader}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
    return data.access_token;
  } catch (err) {
    console.error("Error getting Spotify token:", err.response?.data || err.message);
    return null;
  }
}

// Search Spotify for best track
async function searchSpotifyTrack(query) {
  try {
    const token = await getSpotifyAccessToken();
    if (!token) return null;

    const { data } = await axios.get("https://api.spotify.com/v1/search", {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        q: query,
        type: "track",
        limit: 5,
      },
    });

    if (!data.tracks.items.length) return null;

    return data.tracks.items[0]; // top result
  } catch (err) {
    console.error("Error searching Spotify:", err.response?.data || err.message);
    return null;
  }
}

// Search Apple Music via iTunes Search API (no auth)
async function searchAppleMusicTrack(query) {
  try {
    const { data } = await axios.get("https://itunes.apple.com/search", {
      params: {
        term: query,
        entity: "song",
        limit: 5,
      },
    });

    if (!data.results.length) return null;

    return data.results[0];
  } catch (err) {
    console.error("Error searching Apple (iTunes) API:", err.message);
    return null;
  }
}

// Compute a confidence score 0-100 based on title similarity & popularity
function computeConfidence(cleanedQuery, spotifyTrack) {
  if (!spotifyTrack) return 40; // no direct track, low confidence

  let score = 60; // base for having a track

  const q = normalize(cleanedQuery);
  const trackTitle = normalize(spotifyTrack.name);
  const artistName = normalize(spotifyTrack.artists?.[0]?.name || "");

  if (q.includes(trackTitle) || trackTitle.includes(q)) score += 20;
  if (q.includes(artistName) || artistName.includes(q)) score += 10;
  if (spotifyTrack.popularity >= 70) score += 5;
  if (spotifyTrack.popularity >= 85) score += 5;

  return Math.max(0, Math.min(score, 99));
}

// ---------- Routes ----------

// Health check
app.get("/", (req, res) => {
  res.json({ message: "YT to Spotify backend is running." });
});

// Main convert route
app.post("/api/convert", async (req, res) => {
  try {
    const { youtubeUrl } = req.body;

    if (!youtubeUrl) {
      return res.status(400).json({ error: "YouTube URL is required" });
    }

    // 1) Get YouTube title
    const youtubeTitle = await getYoutubeTitle(youtubeUrl);
    const cleanedQuery = cleanTitle(youtubeTitle || youtubeUrl);

    // 2) Search Spotify + Apple in parallel
    const [spotifyTrack, appleTrack] = await Promise.all([
      searchSpotifyTrack(cleanedQuery),
      searchAppleMusicTrack(cleanedQuery),
    ]);

    // 3) Build URLs
    const spotifyTrackUrl = spotifyTrack
      ? `https://open.spotify.com/track/${spotifyTrack.id}`
      : null;

    const spotifySearchUrl = `https://open.spotify.com/search/${encodeURIComponent(
      cleanedQuery
    )}`;

    const appleTrackUrl = appleTrack?.trackViewUrl || null;

    const appleSearchUrl = `https://music.apple.com/search?term=${encodeURIComponent(
      cleanedQuery
    )}`;

    const soundCloudUrl = `https://soundcloud.com/search?q=${encodeURIComponent(
      cleanedQuery
    )}`;

    // 4) Confidence
    const confidence = computeConfidence(cleanedQuery, spotifyTrack);

    // 5) Response structure your frontend expects
    res.json({
      youtubeTitle: youtubeTitle || "",
      cleanedQuery,
      confidence, // 0-100

      // these will be used as "direct" links if confidence >= 75
      spotifyUrl: spotifyTrackUrl,
      appleMusicUrl: appleTrackUrl,

      // frontend can still use search fallback with cleanedQuery
      soundCloudUrl,
    });
  } catch (err) {
    console.error("Error in /api/convert:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- Server ----------
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
