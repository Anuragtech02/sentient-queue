// server.js
import express from "express";
import Redis from "ioredis";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { config as configDotenv } from "dotenv";
import winston from "winston";
import helmet from "helmet";
import compression from "compression";

// Initialize environment variables based on NODE_ENV
configDotenv({ path: `.env.${process.env.NODE_ENV || "local"}` });

// Validate required environment variables
const requiredEnvVars = ["REDIS_URL", "MAX_ACTIVE_USERS"];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// Configure Winston logger with production settings
const logger = winston.createLogger({
  level:
    process.env.LOG_LEVEL ||
    (process.env.NODE_ENV === "production" ? "info" : "debug"),
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: "queue-service" },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
    new winston.transports.File({
      filename: "logs/error.log",
      level: "error",
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: "logs/combined.log",
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
  ],
});

// Constants with environment variable fallbacks
const CONSTANTS = {
  PORT: process.env.PORT || 8001,
  QUEUE_KEY: "ip_queue",
  ACTIVE_IPS_KEY: "active_ips",
  MAX_ACTIVE_USERS: Number(process.env.MAX_ACTIVE_USERS),
  QUEUE_TIMEOUT: Number(process.env.QUEUE_TIMEOUT) || 300, // 5 minutes in seconds
  CLEANUP_INTERVAL: Number(process.env.CLEANUP_INTERVAL) || 60000, // 1 minute in milliseconds
  ESTIMATE_PER_POSITION: Number(process.env.ESTIMATE_PER_POSITION) || 30, // 30 seconds per position
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",")
    : ["http://localhost:3000"],
  RATE_LIMIT_WINDOW: Number(process.env.RATE_LIMIT_WINDOW) || 60000, // 1 minute
  RATE_LIMIT_MAX: Number(process.env.RATE_LIMIT_MAX) || 30, // requests per window
  REQUEST_TIMEOUT: Number(process.env.REQUEST_TIMEOUT) || 5000, // 5 seconds
};

// Express app initialization
const app = express();

// Redis setup with error handling
const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redis.on("connect", () => {
  logger.info("Successfully connected to Redis");
});

redis.on("error", (err) => {
  logger.error("Redis connection error", { error: err.message });
});

// Middleware setup
app.use(express.json({ limit: "10kb" })); // Limit payload size
app.use(helmet()); // Security headers
app.use(compression()); // Compress responses

// CORS configuration
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "x-forwarded-for"],
    credentials: true,
    maxAge: 86400, // CORS preflight cache 24 hours
  })
);

// Rate limiting
const limiter = rateLimit({
  windowMs: CONSTANTS.RATE_LIMIT_WINDOW,
  max: CONSTANTS.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn("Rate limit exceeded", {
      ip: getClientIP(req),
      path: req.path,
    });
    res.status(429).json({
      error: "Too many requests, please try again later",
      retryAfter: Math.ceil(CONSTANTS.RATE_LIMIT_WINDOW / 1000),
    });
  },
});

app.use(limiter);

// Request timeout middleware
app.use((req, res, next) => {
  res.setTimeout(CONSTANTS.REQUEST_TIMEOUT, () => {
    logger.error("Request timeout", { path: req.path, ip: getClientIP(req) });
    res.status(408).json({ error: "Request timeout" });
  });
  next();
});

// Helper functions
const getClientIP = (req) => {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }
  return req.ip || "unknown";
};

// Input validation middleware
const validateQueueCheck = (req, res, next) => {
  const ip = getClientIP(req);
  if (!ip || ip === "unknown") {
    logger.error("Invalid IP address in request");
    return res.status(400).json({ error: "Invalid IP address" });
  }
  next();
};

// Queue management endpoints
app.post("/api/queue/check", validateQueueCheck, async (req, res) => {
  const ip = getClientIP(req);
  const startTime = Date.now();

  try {
    logger.info(`Queue check request`, { ip });

    const isActive = await redis.sismember(CONSTANTS.ACTIVE_IPS_KEY, ip);
    if (isActive) {
      logger.debug(`IP already active`, { ip });
      return res.json({ position: 0, status: "active" });
    }

    const activeUsers = await redis.scard(CONSTANTS.ACTIVE_IPS_KEY);
    logger.debug(`Active users check`, {
      ip,
      activeUsers,
      maxAllowed: CONSTANTS.MAX_ACTIVE_USERS,
    });

    if (activeUsers < CONSTANTS.MAX_ACTIVE_USERS) {
      const added = await redis.sadd(CONSTANTS.ACTIVE_IPS_KEY, ip);
      logger.info(`New active user added`, { ip, added });
      return res.json({ position: 0, status: "new_active" });
    }

    const timestamp = Date.now();
    await redis.zadd(CONSTANTS.QUEUE_KEY, timestamp, ip);
    const position = await redis.zrank(CONSTANTS.QUEUE_KEY, ip);

    logger.info(`User queued`, {
      ip,
      position: position + 1,
      queueTime: Date.now() - startTime,
    });

    return res.json({
      position: position + 1,
      status: "queued",
      estimatedWaitTime: position * CONSTANTS.ESTIMATE_PER_POSITION,
    });
  } catch (error) {
    logger.error(`Queue check error`, {
      ip,
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/queue/status", validateQueueCheck, async (req, res) => {
  const ip = getClientIP(req);

  try {
    const position = await redis.zrank(CONSTANTS.QUEUE_KEY, ip);
    const response = {
      position: position || 0,
      estimatedWaitTime: (position || 0) * CONSTANTS.ESTIMATE_PER_POSITION,
      timestamp: Date.now(),
    };

    logger.debug(`Queue status check`, { ip, ...response });
    res.json(response);
  } catch (error) {
    logger.error(`Queue status error`, {
      ip,
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/queue/debug", async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res
      .status(403)
      .json({ error: "Debug endpoint disabled in production" });
  }

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
      timestamp: Date.now(),
    });
  } catch (error) {
    logger.error(`Debug endpoint error`, {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: "Internal server error" });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: Date.now(),
    version: process.env.npm_package_version,
  });
});

// Cleanup process
const cleanup = async () => {
  try {
    const now = Date.now();
    const removedCount = await redis.zremrangebyscore(
      CONSTANTS.QUEUE_KEY,
      0,
      now - CONSTANTS.QUEUE_TIMEOUT * 1000
    );

    if (removedCount > 0) {
      logger.info(`Queue cleanup completed`, {
        removedEntries: removedCount,
        timestamp: now,
      });
    }
  } catch (error) {
    logger.error(`Queue cleanup error`, {
      error: error.message,
      stack: error.stack,
    });
  }
};

// Queue resolution process
const resolveQueue = async () => {
  try {
    // Check current active users
    const activeUsers = await redis.scard(CONSTANTS.ACTIVE_IPS_KEY);
    const availableSlots = CONSTANTS.MAX_ACTIVE_USERS - activeUsers;

    if (availableSlots <= 0) {
      logger.debug("No slots available for queue resolution");
      return;
    }

    // Get users from queue ordered by join time
    const queuedUsers = await redis.zrange(
      CONSTANTS.QUEUE_KEY,
      0,
      availableSlots - 1
    );

    if (queuedUsers.length === 0) {
      logger.debug("No users in queue to resolve");
      return;
    }

    logger.info(`Processing ${queuedUsers.length} users from queue`, {
      availableSlots,
      queuedUsers,
    });

    // Process each queued user
    for (const ip of queuedUsers) {
      try {
        // Use multi to ensure atomicity
        const multi = redis.multi();
        multi.sadd(CONSTANTS.ACTIVE_IPS_KEY, ip);
        multi.zrem(CONSTANTS.QUEUE_KEY, ip);

        const results = await multi.exec();

        if (results && results[0][1] === 1) {
          // Check if user was successfully added to active set
          logger.info(`User moved from queue to active`, { ip });
        } else {
          logger.warn(`Failed to move user from queue to active`, { ip });
        }
      } catch (error) {
        logger.error(`Error processing queued user`, {
          ip,
          error: error.message,
        });
      }
    }
  } catch (error) {
    logger.error(`Queue resolution error`, {
      error: error.message,
      stack: error.stack,
    });
  }
};

// Set up intervals for cleanup and queue resolution
const QUEUE_RESOLUTION_INTERVAL =
  Number(process.env.QUEUE_RESOLUTION_INTERVAL) || 5000; // 5 seconds
const cleanupInterval = setInterval(cleanup, CONSTANTS.CLEANUP_INTERVAL);
const queueResolutionInterval = setInterval(
  resolveQueue,
  QUEUE_RESOLUTION_INTERVAL
);

// Graceful shutdown
// Add endpoint to remove user from active set
app.post("/api/queue/deactivate", validateQueueCheck, async (req, res) => {
  const ip = getClientIP(req);

  try {
    const removed = await redis.srem(CONSTANTS.ACTIVE_IPS_KEY, ip);
    logger.info(`User deactivation request`, { ip, removed });

    res.json({
      success: removed === 1,
      message:
        removed === 1 ? "User deactivated" : "User not found in active set",
    });

    // Trigger immediate queue resolution if user was removed
    if (removed === 1) {
      resolveQueue().catch((error) => {
        logger.error("Error in queue resolution after deactivation", {
          error: error.message,
        });
      });
    }
  } catch (error) {
    logger.error(`Deactivation error`, {
      ip,
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: "Internal server error" });
  }
});

const gracefulShutdown = async (signal) => {
  logger.info(`${signal} received, starting graceful shutdown`);

  clearInterval(cleanupInterval);
  clearInterval(queueResolutionInterval);

  // Give active requests 10 seconds to complete
  setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000);

  try {
    await redis.quit();
    logger.info("Redis connection closed");
    process.exit(0);
  } catch (error) {
    logger.error("Error during shutdown", { error: error.message });
    process.exit(1);
  }
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Start server
app.listen(CONSTANTS.PORT, () => {
  logger.info(`Queue server running`, {
    port: CONSTANTS.PORT,
    environment: process.env.NODE_ENV || "development",
    maxActiveUsers: CONSTANTS.MAX_ACTIVE_USERS,
    version: process.env.npm_package_version,
  });
});

// Global error handler
process.on("uncaughtException", (error) => {
  logger.error(`Uncaught exception`, {
    error: error.message,
    stack: error.stack,
  });
  // Give logger time to write before exiting
  setTimeout(() => process.exit(1), 1000);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error(`Unhandled rejection`, {
    reason: reason instanceof Error ? reason.message : reason,
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});
