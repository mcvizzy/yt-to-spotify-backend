// server.js
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

/* -------------------------------------------
   CORS FIX — allows Vercel frontend to call backend
-------------------------------------------- */
app.use(
  cors({
    origin: [
      "https://yt-to-spotify-frontend.vercel.app",
      "http://localhost:5173"
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"]
  })
);

app.use(express.json());

/* -------------------------------------------
   Health check
-------------------------------------------- */
app.get("/", (req, res) => {
  res.json({ message: "YT to Spotify backend is running." });
});

/* -------------------------------------------
   Helper: Get YouTube metadata (no API key)
-------------------------------------------- */
async function getYouTubeMetadata(url) {
  const oembed = "https://www.youtube.com/oembed";

  const response = await axios.get(oembed, {
    params: {
      url,
      format: "json",
    },
  });

  return response.data.title;
}

/* -------------------------------------------
   Helper: Clean YouTube title → search query
-------------------------------------------- */
function cleanTitle(title) {
  if (!title) return "";

  let t = title;

  // remove brackets (Official Video), [HD], etc.
  t = t.replace(/\(.*?\)/g, "").replace(/\[.*?\]/g, "");

  // remove known noise
  const noise = [
    "official music video",
    "official video",
    "music video",
    "video",
    "lyrics",
    "audio",
    "remaster",
    "hd",
    "4k",
  ];

  let lower = t.toLowerCase();
  noise.forEach((n) => (lower = lower.replace(n, "")));

  lower = lower.replace(/\s+/g, " ").trim();

  // format: artist - title
  const dash = lower.split(" - ");
  if (dash.length >= 2) {
    const artist = dash[0].trim();
    const track = dash.slice(1).join(" - ").trim();
    return `${artist} ${track}`.trim();
  }

  return lower;
}

/* -------------------------------------------
   Helper: Normalize strings for matching
-------------------------------------------- */
function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[\(\)\[\]\-_,.:/!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* -------------------------------------------
   Helper: Token-based similarity (Jaccard)
-------------------------------------------- */
function similarity(a, b) {
  const aTokens = new Set(normalize(a).split(" "));
  const bTokens = new Set(normalize(b).split(" "));

  let match = 0;
  aTokens.forEach((t) => {
    if (bTokens.has(t)) match++;
  });

  const total = aTokens.size + bTokens.size - match;
  return total === 0 ? 0 : match / total;
}

/* -------------------------------------------
   Spotify Auth
-------------------------------------------- */
async function getSpotifyToken() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!id || !secret) {
    throw new Error("Missing Spotify credentials");
  }

  const tokenRes = await axios.post(
    "https://accounts.spotify.com/api/token",
    new URLSearchParams({ grant_type: "client_credentials" }).toString(),
    {
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  return tokenRes.data.access_token;
}

/* -------------------------------------------
   Spotify search
-------------------------------------------- */
async function searchSpotify(query) {
  const token = await getSpotifyToken();

  const res = await axios.get("https://api.spotify.com/v1/search", {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      q: query,
      type: "track",
      limit: 5,
    },
  });

  const items = res.data.tracks.items || [];
  if (!items.length) return null;

  let best = null;
  let bestScore = 0;

  for (const track of items) {
    const name = track.name;
    const artists = track.artists.map((a) => a.name).join(" ");
    const full = `${artists} ${name}`;

    let score = similarity(full, query);

    const lowerFull = full.toLowerCase();
    const lowerQuery = query.toLowerCase();

    if (lowerFull.includes("live") !== lowerQuery.includes("live")) {
      score -= 0.1;
    }

    if (
      lowerFull.includes("remix") !== lowerQuery.includes("remix") ||
      lowerFull.includes("mix") !== lowerQuery.includes("mix")
    ) {
      score -= 0.1;
    }

    if (score > bestScore) {
      bestScore = score;
      best = track;
    }
  }

  return { track: best, score: bestScore };
}

/* -------------------------------------------
   Apple Music Search (iTunes API)
-------------------------------------------- */
async function searchApple(query) {
  const res = await axios.get("https://itunes.apple.com/search", {
    params: {
      term: query,
      media: "music",
      entity: "song",
      limit: 5,
    },
  });

  const items = res.data.results || [];
  if (!items.length) return null;

  let best = null;
  let bestScore = 0;

  for (const item of items) {
    const full = `${item.artistName} ${item.trackName}`;
    let score = similarity(full, query);

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return { track: best, score: bestScore };
}

/* -------------------------------------------
   MAIN ROUTE — /api/convert
-------------------------------------------- */
app.post("/api/convert", async (req, res) => {
  try {
    const { youtubeUrl } = req.body;

    if (!youtubeUrl) {
      return res.status(400).json({ error: "YouTube URL required" });
    }

    // STEP 1 — Get YT title
    const rawTitle = await getYouTubeMetadata(youtubeUrl);

    // STEP 2 — Clean title
    const cleanedQuery = cleanTitle(rawTitle);

    // STEP 3 — Spotify + Apple search
    const [sp, ap] = await Promise.allSettled([
      searchSpotify(cleanedQuery),
      searchApple(cleanedQuery),
    ]);

    let spotifyUrl = null;
    let appleUrl = null;
    let spotifyScore = 0;
    let appleScore = 0;

    if (sp.status === "fulfilled" && sp.value?.track) {
      spotifyScore = sp.value.score;
      spotifyUrl = `https://open.spotify.com/track/${sp.value.track.id}`;
    }

    if (ap.status === "fulfilled" && ap.value?.track) {
      appleScore = ap.value.score;
      appleUrl = ap.value.track.trackViewUrl;
    }

    // STEP 4 — Confidence
    let score = 0;
    if (spotifyScore && appleScore) score = spotifyScore * 0.6 + appleScore * 0.4;
    else if (spotifyScore) score = spotifyScore;
    else if (appleScore) score = appleScore;

    let confidence = Math.round(score * 100);
    confidence = Math.max(0, Math.min(confidence, 100));

    // STEP 5 — If confidence too low (<74) use search URLs instead
    const searchSpotifyUrl = `https://open.spotify.com/search/${encodeURIComponent(
      cleanedQuery
    )}`;
    const searchAppleUrl = `https://music.apple.com/us/search?term=${encodeURIComponent(
      cleanedQuery
    )}`;

    if (confidence < 74) {
      spotifyUrl = searchSpotifyUrl;
      appleUrl = searchAppleUrl;
    }

    const soundCloudUrl =
      "https://soundcloud.com/search?q=" + encodeURIComponent(cleanedQuery);

    // Match category
    let matchType = "very_low";
    if (confidence >= 90) matchType = "exact";
    else if (confidence >= 75) matchType = "high";
    else if (confidence >= 50) matchType = "medium";
    else matchType = "low";

    // SEND RESPONSE
    res.json({
      youtubeUrl,
      youtubeTitle: rawTitle,
      cleanedQuery,
      confidence,
      matchType,
      spotifyUrl,
      appleMusicUrl: appleUrl,
      soundCloudUrl,
      debug: {
        spotifyScore,
        appleScore,
      },
    });
  } catch (err) {
    console.error("ERROR /api/convert:", err.response?.data || err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* -------------------------------------------
   Start Server
-------------------------------------------- */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
  console.log(`Backend running on http://localhost:${PORT}`)
);
