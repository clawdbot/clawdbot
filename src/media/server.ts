import fs from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import express, { type Express } from "express";
import { danger } from "../globals.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { detectMime } from "./mime.js";
import { cleanOldMedia, getMediaDir } from "./store.js";

const DEFAULT_TTL_MS = 2 * 60 * 1000;

export function attachMediaRoutes(
  app: Express,
  ttlMs = DEFAULT_TTL_MS,
  _runtime: RuntimeEnv = defaultRuntime,
) {
  const mediaDir = getMediaDir();

  app.get("/media/:id", async (req, res) => {
    const id = req.params.id;
    const mediaRoot = (await fs.realpath(mediaDir)) + path.sep;
    const file = path.resolve(mediaRoot, id);
    try {
      const lstat = await fs.lstat(file);
      if (lstat.isSymbolicLink()) {
        res.status(400).send("invalid path");
        return;
      }
      const realPath = await fs.realpath(file);
      if (!realPath.startsWith(mediaRoot)) {
        res.status(400).send("invalid path");
        return;
      }
      const stat = await fs.stat(realPath);
      if (Date.now() - stat.mtimeMs > ttlMs) {
        await fs.rm(realPath).catch(() => {});
        res.status(410).send("expired");
        return;
      }
      const data = await fs.readFile(realPath);
      const mime = detectMime({ buffer: data, filePath: realPath });
      if (mime) res.type(mime);
      res.send(data);
      // best-effort single-use cleanup after response ends
      res.on("finish", () => {
        setTimeout(() => {
          fs.rm(realPath).catch(() => {});
        }, 50);
      });
    } catch {
      res.status(404).send("not found");
    }
  });

  // periodic cleanup
  setInterval(() => {
    void cleanOldMedia(ttlMs);
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
    const server = app.listen(port);
    server.once("listening", () => resolve(server));
    server.once("error", (err) => {
      runtime.error(danger(`Media server failed: ${String(err)}`));
      reject(err);
    });
  });
}
