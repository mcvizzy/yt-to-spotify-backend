// server.js
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

// CORS
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

// Health
app.get("/", (req, res) => {
  res.json({ message: "YT to Spotify backend is running." });
});

/* -------------------------------------------
   Get YouTube title
-------------------------------------------- */
async function getYouTubeMetadata(url) {
  const oembed = "https://www.youtube.com/oembed";

  const response = await axios.get(oembed, {
    params: { url, format: "json" }
  });

  return response.data.title;
}

/* -------------------------------------------
   Clean title
-------------------------------------------- */
function cleanTitle(title) {
  if (!title) return "";
  let t = title;

  t = t.replace(/\(.*?\)/g, "").replace(/\[.*?\]/g, "");

  const noise = [
    "official music video","official video","music video","video",
    "lyrics","audio","remaster","hd","4k"
  ];

  let lower = t.toLowerCase();
  noise.forEach((n) => (lower = lower.replace(n, "")));
  lower = lower.replace(/\s+/g, " ").trim();

  const dash = lower.split(" - ");
  if (dash.length >= 2) {
    const artist = dash[0].trim();
    const track = dash.slice(1).join(" - ").trim();
    return `${artist} ${track}`.trim();
  }

  return lower;
}

/* -------------------------------------------
   Normalize + similarity
-------------------------------------------- */
function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[\(\)\[\]\-_,.:/!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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
   Spotify auth + search
-------------------------------------------- */
async function getSpotifyToken() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;

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

async function searchSpotify(query) {
  const token = await getSpotifyToken();

  const res = await axios.get("https://api.spotify.com/v1/search", {
    headers: { Authorization: `Bearer ${token}` },
    params: { q: query, type: "track", limit: 5 },
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

    if (full.toLowerCase().includes("live") !== query.toLowerCase().includes("live"))
      score -= 0.1;

    if (
      full.toLowerCase().includes("remix") !== query.toLowerCase().includes("remix")
    )
      score -= 0.1;

    if (score > bestScore) {
      bestScore = score;
      best = track;
    }
  }

  return { track: best, score: bestScore };
}

/* -------------------------------------------
   Apple search
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
    const score = similarity(full, query);

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return { track: best, score: bestScore };
}

/* -------------------------------------------
   MAIN ROUTE
-------------------------------------------- */
app.post("/api/convert", async (req, res) => {
  try {
    const { youtubeUrl } = req.body;

    // 1. YouTube title
    const rawTitle = await getYouTubeMetadata(youtubeUrl);

    // 2. Clean title
    const cleanedQuery = cleanTitle(rawTitle);

    // 3. Spotify + Apple search
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

    // Confidence
    let score =
      spotifyScore && appleScore
        ? spotifyScore * 0.6 + appleScore * 0.4
        : spotifyScore || appleScore;

    let confidence = Math.round((score || 0) * 100);
    confidence = Math.min(Math.max(confidence, 0), 100);

    // 4. FIXED SOUNDCLOUD URL (works in PWA)
    const soundCloudUrl =
      "https://soundcloud.com/search/sounds?q=" +
      encodeURIComponent(cleanedQuery);

    // Fallback: low confidence → search links
    const spotifySearch = `https://open.spotify.com/search/${encodeURIComponent(
      cleanedQuery
    )}`;
    const appleSearch = `https://music.apple.com/us/search?term=${encodeURIComponent(
      cleanedQuery
    )}`;

    if (confidence < 74) {
      spotifyUrl = spotifySearch;
      appleUrl = appleSearch;
    }

    // Match level
    let matchType = "low";
    if (confidence >= 90) matchType = "exact";
    else if (confidence >= 75) matchType = "high";
    else if (confidence >= 50) matchType = "medium";

    // Response
    res.json({
      youtubeUrl,
      youtubeTitle: rawTitle,
      cleanedQuery,
      confidence,
      matchType,
      spotifyUrl,
      appleMusicUrl: appleUrl,
      soundCloudUrl,
    });
  } catch (err) {
    console.error("Convert error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* -------------------------------------------
   Start Server
-------------------------------------------- */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
  console.log(`Backend running on port ${PORT}`)
);
