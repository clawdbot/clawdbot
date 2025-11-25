import fs from "node:fs/promises";
import path from "node:path";
import express, { type Express } from "express";
import type { Server } from "http";
import { danger } from "../globals.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { cleanOldMedia, getMediaDir } from "./store.js";

const DEFAULT_TTL_MS = 2 * 60 * 1000;

export function attachMediaRoutes(
	app: Express,
	ttlMs = DEFAULT_TTL_MS,
	runtime: RuntimeEnv = defaultRuntime,
) {
	const mediaDir = getMediaDir();

	app.get("/media/:id", async (req, res) => {
		const id = req.params.id;
		const file = path.join(mediaDir, id);
		try {
			const stat = await fs.stat(file);
			if (Date.now() - stat.mtimeMs > ttlMs) {
				await fs.rm(file).catch(() => {});
				res.status(410).send("expired");
				return;
			}
			res.sendFile(file);
			// best-effort single-use cleanup after response ends
			res.on("finish", () => {
				setTimeout(() => {
					fs.rm(file).catch(() => {});
				}, 500);
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
