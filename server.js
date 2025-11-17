// server.js
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Test route
app.get("/", (req, res) => {
  res.json({ message: "YT to Spotify backend is running." });
});

// ----------------------------------------------------
//  POST /api/convert
//  This is where your logic goes for:
//  - extracting YouTube metadata
//  - matching Spotify track
//  - matching Apple Music track
//  - returning confidence %
// ----------------------------------------------------
app.post("/api/convert", async (req, res) => {
  try {
    const { youtubeUrl } = req.body;

    if (!youtubeUrl) {
      return res.status(400).json({ error: "YouTube URL is required" });
    }

    // 🔥 PLACEHOLDER LOGIC
    // Replace this with your real conversion logic

    const fakeResult = {
      youtubeUrl,
      spotifyTrack: "https://open.spotify.com/track/FAKE_TRACK_ID",
      appleMusicTrack: "https://music.apple.com/FAKE_TRACK",
      confidence: 92, // mock confidence score
    };

    res.json(fakeResult);
  } catch (err) {
    console.error("Error in /api/convert:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ----------------------------------------------------
//  Server Listener
//  Render requires process.env.PORT
// ----------------------------------------------------
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
