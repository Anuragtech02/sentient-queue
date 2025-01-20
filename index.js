// server.ts
import express from "express";
import Redis from "ioredis";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { configDotenv } from "dotenv";

configDotenv();

const app = express();
const port = process.env.PORT || 8001;

// Redis setup
const redis = new Redis(process.env.REDIS_URL || "");

redis.on("connect", () => {
  console.log("Successfully connected to Redis");
});

redis.on("error", (err) => {
  console.error("Redis connection error:", err);
});

// Constants
const QUEUE_KEY = "ip_queue";
const ACTIVE_IPS_KEY = "active_ips";
const MAX_ACTIVE_USERS = 400;
const QUEUE_TIMEOUT = 300; // 5 minutes

// Middleware
app.use(express.json());
app.use(
  cors({
    origin: process.env.NEXTJS_URL || "http://localhost:3000",
    credentials: true,
  })
);

// Rate limiting
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
});

app.use(limiter);

// Queue management endpoints
app.post("/api/queue/check", async (req, res) => {
  try {
    const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";

    // Check if IP is already active
    const isActive = await redis.sismember(ACTIVE_IPS_KEY, ip);
    if (isActive) {
      return res.json({ position: 0 });
    }

    const activeUsers = await redis.scard(ACTIVE_IPS_KEY);

    if (activeUsers < MAX_ACTIVE_USERS) {
      await redis.sadd(ACTIVE_IPS_KEY, ip);
      await redis.expire(ACTIVE_IPS_KEY, QUEUE_TIMEOUT);
      return res.json({ position: 0 });
    }

    // Add to queue
    await redis.zadd(QUEUE_KEY, Date.now(), ip);
    const position = await redis.zrank(QUEUE_KEY, ip);

    res.json({
      position: position || 0,
      estimatedWaitTime: (position || 0) * 30, // 30 seconds per position
    });
  } catch (error) {
    console.error("Queue check error:", error);
    res.status(500).json({ error: "Failed to check queue position" });
  }
});

app.get("/api/queue/status", async (req, res) => {
  try {
    const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
    const position = await redis.zrank(QUEUE_KEY, ip);

    res.json({
      position: position || 0,
      estimatedWaitTime: (position || 0) * 30,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("Queue status error:", error);
    res.status(500).json({ error: "Failed to get queue status" });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "healthy" });
});

// Start cleanup process
setInterval(async () => {
  try {
    // Remove old entries
    const now = Date.now();
    await redis.zremrangebyscore(QUEUE_KEY, 0, now - QUEUE_TIMEOUT * 1000);
  } catch (error) {
    console.error("Cleanup error:", error);
  }
}, 60000); // Run every minute

// Start server
app.listen(port, () => {
  console.log(`Queue server running on port ${port}`);
});
