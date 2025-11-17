// server.js
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Simple health check
app.get("/", (req, res) => {
  res.json({ message: "YT to Spotify backend is running." });
});

// ---------- CONFIG ----------
const CONFIDENCE_SEARCH_THRESHOLD = 74;

// ---------- HELPERS ----------

// 1) Get YouTube metadata via oEmbed (no API key required)
async function getYoutubeMetadata(youtubeUrl) {
  const oembedUrl = "https://www.youtube.com/oembed";
  const res = await axios.get(oembedUrl, {
    params: { url: youtubeUrl, format: "json" },
  });

  return {
    title: res.data.title, // e.g. "Artist - Track (Official Video)"
  };
}

// 2) Clean up YouTube title into a good search query
function cleanYoutubeTitle(rawTitle) {
  if (!rawTitle) return "";

  let title = rawTitle;

  // Remove bracketed stuff: (Official Video), [HD], etc.
  title = title.replace(/\(.*?\)/g, "").replace(/\[.*?\]/g, "");

  // Common noise words to remove
  const noise = [
    "official video",
    "official music video",
    "music video",
    "lyrics",
    "audio",
    "video",
    "hd",
    "4k",
    "remastered",
    "remaster",
  ];

  let lower = title.toLowerCase();
  noise.forEach((word) => {
    lower = lower.replace(word, "");
  });

  // Collapse multiple spaces
  lower = lower.replace(/\s+/g, " ").trim();

  // Try to detect "artist - track" pattern
  const dashParts = lower.split(" - ");
  if (dashParts.length >= 2) {
    const artist = dashParts[0].trim();
    const track = dashParts.slice(1).join(" - ").trim();
    return `${artist} ${track}`.trim();
  }

  return lower;
}

// Normalize strings for similarity
function normalizeForMatch(str) {
  return str
    .toLowerCase()
    .replace(/[\(\)\[\]\-_,.:/!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Simple token-based similarity (Jaccard)
function tokenSimilarity(a, b) {
  const aTokens = new Set(normalizeForMatch(a).split(" ").filter(Boolean));
  const bTokens = new Set(normalizeForMatch(b).split(" ").filter(Boolean));

  if (!aTokens.size || !bTokens.size) return 0;

  let intersection = 0;
  aTokens.forEach((t) => {
    if (bTokens.has(t)) intersection += 1;
  });

  const union = aTokens.size + bTokens.size - intersection;
  return intersection / union;
}

// 3) Spotify auth & search
async function getSpotifyAccessToken() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET");
  }

  const tokenRes = await axios.post(
    "https://accounts.spotify.com/api/token",
    new URLSearchParams({ grant_type: "client_credentials" }).toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " +
          Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      },
    }
  );

  return tokenRes.data.access_token;
}

async function searchSpotifyTrack(query) {
  const accessToken = await getSpotifyAccessToken();

  const res = await axios.get("https://api.spotify.com/v1/search", {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: {
      q: query,
      type: "track",
      limit: 5,
    },
  });

  const items = res.data.tracks.items || [];
  if (!items.length) return null;

  // Score each track vs our cleaned query
  let best = null;
  let bestScore = 0;

  for (const track of items) {
    const trackName = track.name;
    const artistNames = track.artists.map((a) => a.name).join(" ");
    const combined = `${artistNames} ${trackName}`;

    let score = tokenSimilarity(combined, query);

    // Penalize mismatched "live" / "remix"
    const combinedLower = combined.toLowerCase();
    const queryLower = query.toLowerCase();

    const hasLive = combinedLower.includes("live");
    const queryLive = queryLower.includes("live");
    if (hasLive !== queryLive) score -= 0.1;

    const hasRemix =
      combinedLower.includes("remix") || combinedLower.includes("mix");
    const queryRemix =
      queryLower.includes("remix") || queryLower.includes("mix");
    if (hasRemix !== queryRemix) score -= 0.1;

    if (score > bestScore) {
      bestScore = score;
      best = track;
    }
  }

  return {
    track: best,
    score: Math.max(0, bestScore),
  };
}

// 4) Apple Music / iTunes search
async function searchAppleTrack(query) {
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
    const trackName = item.trackName || "";
    const artistName = item.artistName || "";
    const combined = `${artistName} ${trackName}`;

    let score = tokenSimilarity(combined, query);

    const combinedLower = combined.toLowerCase();
    const queryLower = query.toLowerCase();
    const hasLive = combinedLower.includes("live");
    const queryLive = queryLower.includes("live");
    if (hasLive !== queryLive) score -= 0.1;

    const hasRemix =
      combinedLower.includes("remix") || combinedLower.includes("mix");
    const queryRemix =
      queryLower.includes("remix") || queryLower.includes("mix");
    if (hasRemix !== queryRemix) score -= 0.1;

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return {
    track: best,
    score: Math.max(0, bestScore),
  };
}

// ---------- MAIN ROUTE ----------

app.post("/api/convert", async (req, res) => {
  try {
    const { youtubeUrl } = req.body;

    if (!youtubeUrl) {
      return res.status(400).json({ error: "YouTube URL is required" });
    }

    // Step 1: Get YouTube metadata
    const ytMeta = await getYoutubeMetadata(youtubeUrl);
    const youtubeTitle = ytMeta.title;

    // Step 2: Clean to a search query
    const cleanedQuery = cleanYoutubeTitle(youtubeTitle);

    // Step 3: Search Spotify & Apple
    const [spotifyResult, appleResult] = await Promise.allSettled([
      searchSpotifyTrack(cleanedQuery),
      searchAppleTrack(cleanedQuery),
    ]);

    let spotifyUrl = null;
    let appleMusicUrl = null;
    let spotifyScore = 0;
    let appleScore = 0;

    if (spotifyResult.status === "fulfilled" && spotifyResult.value?.track) {
      const track = spotifyResult.value.track;
      spotifyScore = spotifyResult.value.score;
      spotifyUrl = `https://open.spotify.com/track/${track.id}`;
    }

    if (appleResult.status === "fulfilled" && appleResult.value?.track) {
      const item = appleResult.value.track;
      appleScore = appleResult.value.score;
      appleMusicUrl = item.trackViewUrl;
    }

    // If nothing found anywhere, just return search links
    const spotifySearchUrl = `https://open.spotify.com/search/${encodeURIComponent(
      cleanedQuery
    )}`;
    const appleSearchUrl = `https://music.apple.com/us/search?term=${encodeURIComponent(
      cleanedQuery
    )}`;

    // Global confidence: prefer Spotify score, fall back to Apple, then 0
    let confidenceScore = 0;
    if (spotifyScore && appleScore) {
      confidenceScore = (spotifyScore * 0.6 + appleScore * 0.4);
    } else if (spotifyScore) {
      confidenceScore = spotifyScore;
    } else if (appleScore) {
      confidenceScore = appleScore;
    } else {
      confidenceScore = 0;
    }

    let confidence = Math.round(confidenceScore * 100);
    if (confidence > 100) confidence = 100;
    if (confidence < 0) confidence = 0;

    // Decide match type + behavior based on confidence
    let matchType = "very_low";
    if (confidence >= 90) matchType = "exact";
    else if (confidence >= 75) matchType = "high";
    else if (confidence >= 50) matchType = "medium";
    else matchType = "low";

    // If confidence is too low, force search URLs instead of direct tracks
    let finalSpotifyUrl = spotifyUrl || spotifySearchUrl;
    let finalAppleUrl = appleMusicUrl || appleSearchUrl;

    if (confidence < CONFIDENCE_SEARCH_THRESHOLD) {
      finalSpotifyUrl = spotifySearchUrl;
      finalAppleUrl = appleSearchUrl;
    }

    const soundCloudUrl = `https://soundcloud.com/search?q=${encodeURIComponent(
      cleanedQuery
    )}`;

    res.json({
      youtubeUrl,
      youtubeTitle,
      cleanedQuery,
      confidence,
      matchType,
      spotifyUrl: finalSpotifyUrl,
      appleMusicUrl: finalAppleUrl,
      soundCloudUrl,
      debug: {
        rawSpotifyScore: spotifyScore,
        rawAppleScore: appleScore,
      },
    });
  } catch (err) {
    console.error("Error in /api/convert:", err?.response?.data || err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- LISTENER ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
