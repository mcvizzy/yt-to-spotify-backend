// server.js
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

// CORS: allow your frontend & local dev
app.use(
  cors({
    origin: [
      "https://yt-to-spotify-frontend.vercel.app",
      "http://localhost:5173",
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ message: "YT → Music backend is running." });
});

/* -------------------------------------------
   Platform detection (YouTube / TikTok)
-------------------------------------------- */
function detectPlatform(url) {
  const lower = url.toLowerCase();
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) {
    return "youtube";
  }
  if (lower.includes("tiktok.com")) {
    return "tiktok";
  }
  return "unknown";
}

/* -------------------------------------------
   Fetch metadata from YouTube / TikTok
-------------------------------------------- */
async function getTrackMetadata(inputUrl) {
  const platform = detectPlatform(inputUrl);

  if (platform === "youtube") {
    // YouTube oEmbed
    const res = await axios.get("https://www.youtube.com/oembed", {
      params: { url: inputUrl, format: "json" },
    });

    return {
      platform,
      title: res.data.title || "",
      // YouTube doesn't give artist separately here
      artist: "",
    };
  }

  if (platform === "tiktok") {
    // TikTok oEmbed
    const res = await axios.get("https://www.tiktok.com/oembed", {
      params: { url: inputUrl },
    });

    return {
      platform,
      title: res.data.title || "",
      artist: res.data.author_name || "",
    };
  }

  throw new Error("Unsupported URL. Use YouTube or TikTok links.");
}

/* -------------------------------------------
   Title cleaning → search query
-------------------------------------------- */
function cleanTitleForSearch({ platform, title, artist }) {
  let base = "";

  if (platform === "tiktok") {
    // Use "artist + title" for TikTok
    base = `${artist} ${title}`.trim();
  } else {
    // YouTube: just title
    base = title || "";
  }

  if (!base) return "";

  // Remove bracketed junk
  base = base.replace(/\(.*?\)/g, "").replace(/\[.*?\]/g, "");

  // Remove noise words
  const noise = [
    "official music video",
    "official video",
    "music video",
    "video",
    "lyrics",
    "audio",
    "remaster",
    "remastered",
    "hd",
    "4k",
    "tiktok",
    "sound",
  ];

  let lower = base.toLowerCase();
  noise.forEach((n) => {
    lower = lower.replace(n, "");
  });

  // Collapse whitespace
  lower = lower.replace(/\s+/g, " ").trim();

  // Handle artist - track case
  const dash = lower.split(" - ");
  if (dash.length >= 2) {
    const artistPart = dash[0].trim();
    const trackPart = dash.slice(1).join(" - ").trim();
    return `${artistPart} ${trackPart}`.trim();
  }

  return lower;
}

/* -------------------------------------------
   Normalization + similarity
-------------------------------------------- */
function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[\(\)\[\]\-_,.:/!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a, b) {
  const aTokens = new Set(normalize(a).split(" ").filter(Boolean));
  const bTokens = new Set(normalize(b).split(" ").filter(Boolean));

  if (!aTokens.size || !bTokens.size) return 0;

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
    const name = track.name || "";
    const artists = (track.artists || []).map((a) => a.name).join(" ");
    const full = `${artists} ${name}`.trim();

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

  return { track: best, score: Math.max(0, bestScore) };
}

/* -------------------------------------------
   Apple Music / iTunes search
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
    const full = `${item.artistName || ""} ${item.trackName || ""}`.trim();
    const score = similarity(full, query);

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return { track: best, score: Math.max(0, bestScore) };
}

/* -------------------------------------------
   MAIN ROUTE — /api/convert
-------------------------------------------- */
app.post("/api/convert", async (req, res) => {
  try {
    const { youtubeUrl } = req.body;
    const inputUrl = youtubeUrl;

    if (!inputUrl) {
      return res.status(400).json({ error: "URL is required" });
    }

    // 1. Detect platform & get metadata
    const meta = await getTrackMetadata(inputUrl);
    const { platform, title, artist } = meta;

    // 2. Clean to search query
    const cleanedQuery = cleanTitleForSearch(meta);

    // 3. Search Spotify + Apple
    const [spRes, apRes] = await Promise.allSettled([
      searchSpotify(cleanedQuery),
      searchApple(cleanedQuery),
    ]);

    let spotifyUrl = null;
    let appleUrl = null;
    let spotifyScore = 0;
    let appleScore = 0;

    if (spRes.status === "fulfilled" && spRes.value?.track) {
      spotifyScore = spRes.value.score;
      spotifyUrl = `https://open.spotify.com/track/${spRes.value.track.id}`;
    }

    if (apRes.status === "fulfilled" && apRes.value?.track) {
      appleScore = apRes.value.score;
      appleUrl = apRes.value.track.trackViewUrl;
    }

    // 4. Confidence
    let rawScore = 0;
    if (spotifyScore && appleScore) {
      rawScore = spotifyScore * 0.6 + appleScore * 0.4;
    } else if (spotifyScore) {
      rawScore = spotifyScore;
    } else if (appleScore) {
      rawScore = appleScore;
    }

    let confidence = Math.round(rawScore * 100);
    if (Number.isNaN(confidence)) confidence = 0;
    confidence = Math.min(Math.max(confidence, 0), 100);

    // 5. Search fallback if confidence low
    const spotifySearchUrl = `https://open.spotify.com/search/${encodeURIComponent(
      cleanedQuery
    )}`;
    const appleSearchUrl = `https://music.apple.com/us/search?term=${encodeURIComponent(
      cleanedQuery
    )}`;

    if (confidence < 74 || !spotifyUrl) {
      spotifyUrl = spotifySearchUrl;
    }
    if (confidence < 74 || !appleUrl) {
      appleUrl = appleSearchUrl;
    }

    // SoundCloud search — PWA-safe format
    const soundCloudUrl =
      "https://soundcloud.com/search/sounds?q=" +
      encodeURIComponent(cleanedQuery);

    // Match-level labels (for future UI use)
    let matchType = "very_low";
    if (confidence >= 90) matchType = "exact";
    else if (confidence >= 75) matchType = "high";
    else if (confidence >= 50) matchType = "medium";
    else matchType = "low";

    res.json({
      platform, // "youtube" or "tiktok"
      youtubeUrl: inputUrl,
      youtubeTitle: title,
      artist,
      cleanedQuery,
      confidence,
      matchType,
      spotifyUrl,
      appleMusicUrl: appleUrl,
      soundCloudUrl,
    });
  } catch (err) {
    console.error("Error in /api/convert:", err.response?.data || err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* -------------------------------------------
   Start server
-------------------------------------------- */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
