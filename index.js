// server.js
import express from "express";
import Redis from "ioredis";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { config as configDotenv } from "dotenv";
import winston from "winston";

// Initialize environment variables
configDotenv();

// Configure Winston logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
    new winston.transports.File({
      filename: "error.log",
      level: "error",
    }),
    new winston.transports.File({
      filename: "combined.log",
    }),
  ],
});

// Constants
const CONSTANTS = {
  PORT: process.env.PORT || 8001,
  QUEUE_KEY: "ip_queue",
  ACTIVE_IPS_KEY: "active_ips",
  MAX_ACTIVE_USERS: Number(process.env.MAX_ACTIVE_USERS) || 1,
  QUEUE_TIMEOUT: 300, // 5 minutes in seconds
  CLEANUP_INTERVAL: 60000, // 1 minute in milliseconds
  ESTIMATE_PER_POSITION: 30, // 30 seconds per position
};

// Express app initialization
const app = express();

// Redis setup
const redis = new Redis(process.env.REDIS_URL || "");

redis.on("connect", () => {
  logger.info("Successfully connected to Redis");
});

redis.on("error", (err) => {
  logger.error("Redis connection error", { error: err.message });
});

// Middleware setup
app.use(express.json());
app.use(
  cors({
    origin: "*",
    credentials: true,
  })
);

// Rate limiting
// const limiter = rateLimit({
//   windowMs: 60 * 1000, // 1 minute
//   max: 30, // 30 requests per minute
//   handler: (req, res) => {
//     logger.warn("Rate limit exceeded", {
//       ip: req.ip,
//       path: req.path,
//     });
//     res.status(429).json({
//       error: "Too many requests, please try again later",
//     });
//   },
// });

// app.use(limiter);

// Helper functions
const getClientIP = (req) => {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (forwardedFor) {
    // Get the first IP if multiple are present
    return forwardedFor.split(",")[0].trim();
  }
  return req.ip || "unknown";
};

// Queue management endpoints
// In server.js, update the /api/queue/check endpoint:
app.post("/api/queue/check", async (req, res) => {
  try {
    const ip = getClientIP(req);
    logger.info(`Request from IP: ${ip}`);

    // First, check if already active
    const isActive = await redis.sismember(CONSTANTS.ACTIVE_IPS_KEY, ip);
    logger.info(`IP ${ip} active status: ${isActive}`);

    if (isActive) {
      return res.json({ position: 0, status: "active" });
    }

    // Check active users count
    const activeUsers = await redis.scard(CONSTANTS.ACTIVE_IPS_KEY);
    logger.info(
      `Current active users: ${activeUsers}, Max allowed: ${CONSTANTS.MAX_ACTIVE_USERS}`
    );

    if (activeUsers < CONSTANTS.MAX_ACTIVE_USERS) {
      const added = await redis.sadd(CONSTANTS.ACTIVE_IPS_KEY, ip);
      logger.info(`Added ${ip} to active users: ${added}`);
      return res.json({ position: 0, status: "new_active" });
    }

    // User needs to be queued
    const timestamp = Date.now();
    await redis.zadd(CONSTANTS.QUEUE_KEY, timestamp, ip);
    const position = await redis.zrank(CONSTANTS.QUEUE_KEY, ip);
    logger.info(`Added ${ip} to queue at position: ${position}`);

    return res.json({
      position: position + 1,
      status: "queued",
      estimatedWaitTime: position * CONSTANTS.ESTIMATE_PER_POSITION,
    });
  } catch (error) {
    logger.error(`Queue error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/queue/status", async (req, res) => {
  const ip = getClientIP(req);

  try {
    logger.debug("Checking queue status", { ip });

    const position = await redis.zrank(CONSTANTS.QUEUE_KEY, ip);
    const response = {
      position: position || 0,
      estimatedWaitTime: (position || 0) * CONSTANTS.ESTIMATE_PER_POSITION,
      timestamp: Date.now(),
    };

    res.json(response);
  } catch (error) {
    logger.error("Queue status error", {
      ip,
      error: error.message || "Unknown error",
    });
    res.status(500).json({
      error: "Failed to get queue status",
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  logger.debug("Health check requested");
  res.json({ status: "healthy" });
});

app.get("/api/queue/debug", async (req, res) => {
  try {
    const [activeUsers, queueLength, queuedUsers] = await Promise.all([
      redis.smembers(CONSTANTS.ACTIVE_IPS_KEY),
      redis.zcard(CONSTANTS.QUEUE_KEY),
      redis.zrange(CONSTANTS.QUEUE_KEY, 0, -1, "WITHSCORES"),
    ]);

    res.json({
      activeUsers: activeUsers.length,
      activeIPs: activeUsers,
      queueLength,
      queuedUsers,
      maxActiveUsers: CONSTANTS.MAX_ACTIVE_USERS,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/queue/reset", async (req, res) => {
  await redis.del(CONSTANTS.QUEUE_KEY, CONSTANTS.ACTIVE_IPS_KEY);
  res.json({ message: "Queue reset" });
});

// Cleanup process
setInterval(async () => {
  try {
    const now = Date.now();
    const removedCount = await redis.zremrangebyscore(
      CONSTANTS.QUEUE_KEY,
      0,
      now - CONSTANTS.QUEUE_TIMEOUT * 1000
    );

    logger.info("Cleanup completed", {
      removedEntries: removedCount,
    });
  } catch (error) {
    logger.error("Cleanup error", {
      error: error.message || "Unknown error",
    });
  }
}, CONSTANTS.CLEANUP_INTERVAL);

// Start server
app.listen(CONSTANTS.PORT, () => {
  logger.info(`Queue server running`, {
    port: CONSTANTS.PORT,
    environment: process.env.NODE_ENV || "development",
  });
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, shutting down gracefully");
  await redis.quit();
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});
