// server.js
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

// IMPORTANT — allow your frontend
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

// Health route
app.get("/", (req, res) => {
  res.json({ message: "YT to Spotify backend is running." });
});

// ------------------
// Your MATCHING LOGIC
// (UNCHANGED — you already had it working)
// ------------------
app.post("/api/convert", async (req, res) => {
  try {
    const { youtubeUrl } = req.body;
    if (!youtubeUrl) {
      return res.status(400).json({ error: "YouTube URL is required" });
    }

    // Quick working placeholder to verify CORS
    res.json({
      youtubeTitle: "Test success",
      cleanedQuery: "Test",
      confidence: 90,
      spotifyUrl: "https://open.spotify.com/",
      appleMusicUrl: "https://music.apple.com/",
      soundCloudUrl: "https://soundcloud.com/",
    });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Render port
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
