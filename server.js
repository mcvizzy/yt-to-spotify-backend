const express = require("express");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config();

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

async function getSpotifyToken() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;

  const auth = Buffer.from(id + ":" + secret).toString("base64");

  const r = await axios.post(
    "https://accounts.spotify.com/api/token",
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: "Basic " + auth,
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  return r.data.access_token;
}

async function searchSpotifyTrack(query, artist, song) {
  try {
    const token = await getSpotifyToken();

    const r = await axios.get("https://api.spotify.com/v1/search", {
      params: { q: query, type: "track", limit: 5 },
      headers: { Authorization: "Bearer " + token }
    });

    const items = r.data.tracks.items;
    if (!items || items.length === 0) {
      return { url: null, score: 0 };
    }

    let best = null;

    for (const item of items) {
      const title = item.name;
      const artists = item.artists.map(a => a.name).join(" ");

      const s1 = similarity(title, song);
      const s2 = similarity(artists, artist);
      const score = s1 + s2;

      if (!best || score > best.score) {
        best = {
          url: item.external_urls.spotify,
          score: score
        };
      }
    }

    return best;
  } catch (e) {
    console.log("Spotify error:", e.message);
    return { url: null, score: 0 };
  }
}

function similarity(a = "", b = "") {
  if (!a || !b) return 0;

  a = a.toLowerCase();
  b = b.toLowerCase();

  const A = new Set(a.split(""));
  const B = new Set(b.split(""));

  let matches = 0;
  A.forEach(ch => {
    if (B.has(ch)) matches++;
  });

  return matches / Math.max(a.length, b.length);
}

async function searchAppleMusicTrack(artist, song) {
  const queries = [];

  if (artist && song) {
    queries.push(artist + " " + song);
    queries.push(song + " " + artist);
  }

  queries.push(song);

  if (artist) {
    queries.push(artist);
  }

  let best = null;

  for (const q of queries) {
    try {
      const r = await axios.get("https://itunes.apple.com/search", {
        params: { term: q, media: "music", limit: 5 }
      });

      const results = r.data.results;
      if (!results || results.length === 0) continue;

      for (const item of results) {
        const s1 = similarity(item.trackName, song);
        const s2 = similarity(item.artistName, artist);
        const score = s1 + s2;

        if (!best || score > best.score) {
          best = { url: item.trackViewUrl, score: score };
        }
      }
    } catch (e) {
      console.log("Apple error:", e.message);
    }
  }

  return best;
}

function extractArtistAndSong(title) {
  const seps = [" - ", " – ", " — ", ": "];

  for (const sep of seps) {
    if (title.includes(sep)) {
      const parts = title.split(sep);
      return {
        artist: parts[0].trim(),
        song: parts[1].trim()
      };
    }
  }

  return { artist: "", song: title.trim() };
}

app.get("/", (req, res) => {
  res.send("Backend running");
});

app.post("/api/convert", async (req, res) => {
  const youtubeUrl = req.body.youtubeUrl;

  if (!youtubeUrl) {
    return res.status(400).json({ error: "youtubeUrl is required" });
  }

  try {
    const meta = await axios.get("https://noembed.com/embed", {
      params: { url: youtubeUrl }
    });

    if (!meta.data || !meta.data.title) {
      return res
        .status(404)
        .json({ error: "Could not extract YouTube title" });
    }

    const original = meta.data.title;

    let cleaned = original
      .replace(/\(.*official.*\)/gi, "")
      .replace(/\[.*official.*\]/gi, "")
      .replace(/\(.*video.*\)/gi, "")
      .replace(/\[.*video.*\]/gi, "")
      .replace(/official/gi, "")
      .replace(/lyrics?/gi, "")
      .replace(/video/gi, "")
      .replace(/HD|4K/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    const parsed = extractArtistAndSong(cleaned);
    const artist = parsed.artist;
    const song = parsed.song;

    const sSpotify = await searchSpotifyTrack(cleaned, artist, song);
    const sApple = await searchAppleMusicTrack(artist, song);

    const spotifySearch =
      "https://open.spotify.com/search/" +
      encodeURIComponent(artist + " " + song);

    const appleSearch =
      "https://music.apple.com/us/search?term=" +
      encodeURIComponent(artist + " " + song);

    let spotifyUrl = null;

    if (sSpotify && sSpotify.score >= 1.0) {
      spotifyUrl = sSpotify.url;
    }

    let appleUrl = null;

    if (sApple && sApple.score >= 1.0) {
      appleUrl = sApple.url;
    }

    const spotifyPercent = Math.round((sSpotify.score / 2) * 100);
    const applePercent = Math.round((sApple.score / 2) * 100);

    res.json({
      youtubeTitle: original,
      cleanedQuery: cleaned,
      artist: artist,
      song: song,
      spotifyUrl: spotifyUrl,
      spotifySearch: spotifySearch,
      appleUrl: appleUrl,
      appleSearch: appleSearch,
      confidence: {
        spotify: spotifyPercent,
        apple: applePercent
      }
    });

  } catch (e) {
    console.log("Convert error:", e.response?.data || e.message);
    res.status(500).json({ error: "Server error converting link" });
  }
});

app.listen(PORT, () => {
  console.log("Backend running at http://localhost:" + PORT);
});
