import fs from "node:fs/promises";
import type { Server } from "node:http";
import express, { type Express, type RequestHandler } from "express";
import { danger } from "../globals.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { detectMime } from "./mime.js";
import {
  cleanOldMedia,
  getMediaDir,
  isSafeOpenError,
  MEDIA_MAX_BYTES,
  readFileWithinRoot,
} from "./server.runtime.js";

const DEFAULT_TTL_MS = 2 * 60 * 1000;
const MAX_MEDIA_ID_CHARS = 200;
const MEDIA_ID_PATTERN = /^[\p{L}\p{N}._-]+$/u;
const MAX_MEDIA_BYTES = MEDIA_MAX_BYTES;

function asyncMediaRoute(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

const isValidMediaId = (id: string) => {
  if (!id) {
    return false;
  }
  if (id.length > MAX_MEDIA_ID_CHARS) {
    return false;
  }
  if (id === "." || id === "..") {
    return false;
  }
  return MEDIA_ID_PATTERN.test(id);
};

export function attachMediaRoutes(
  app: Express,
  ttlMs = DEFAULT_TTL_MS,
  _runtime: RuntimeEnv = defaultRuntime,
) {
  const mediaDir = getMediaDir();

  app.get(
    "/media/:id",
    asyncMediaRoute(async (req, res) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      const id = typeof req.params.id === "string" ? req.params.id : "";
      if (!isValidMediaId(id)) {
        res.status(400).send("invalid path");
        return;
      }
      try {
        const {
          buffer: data,
          realPath,
          stat,
        } = await readFileWithinRoot({
          rootDir: mediaDir,
          relativePath: id,
          maxBytes: MAX_MEDIA_BYTES,
        });
        if (Date.now() - stat.mtimeMs > ttlMs) {
          await fs.rm(realPath).catch(() => {});
          res.status(410).send("expired");
          return;
        }
        const mime = await detectMime({ buffer: data, filePath: realPath });
        if (mime) {
          res.type(mime);
        }
        res.send(data);
        // best-effort single-use cleanup after response ends
        res.on("finish", () => {
          const cleanup = () => {
            void fs.rm(realPath).catch(() => {});
          };
          // Tests should not pay for time-based cleanup delays.
          if (process.env.VITEST || process.env.NODE_ENV === "test") {
            queueMicrotask(cleanup);
            return;
          }
          setTimeout(cleanup, 50);
        });
      } catch (err) {
        if (isSafeOpenError(err)) {
          if (err.code === "outside-workspace") {
            res.status(400).send("file is outside workspace root");
            return;
          }
          if (err.code === "invalid-path") {
            res.status(400).send("invalid path");
            return;
          }
          if (err.code === "not-found") {
            res.status(404).send("not found");
            return;
          }
          if (err.code === "too-large") {
            res.status(413).send("too large");
            return;
          }
        }
        res.status(404).send("not found");
      }
    }),
  );

  // periodic cleanup
  setInterval(() => {
    void cleanOldMedia(ttlMs, { recursive: false });
  }, ttlMs).unref();
}

export async function startMediaServer(
  port: number,
  ttlMs = DEFAULT_TTL_MS,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<Server> {
  const app = express();
  attachMediaRoutes(app, ttlMs, runtime);
  return await new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1");
    server.once("listening", () => resolve(server));
    server.once("error", (err) => {
      runtime.error(danger(`Media server failed: ${String(err)}`));
      reject(err);
    });
  });
}
