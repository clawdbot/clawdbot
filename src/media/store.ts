import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { request } from "node:https";

const MEDIA_DIR = path.join(os.homedir(), ".warelay", "media");
const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 minutes

export function getMediaDir() {
	return MEDIA_DIR;
}

export async function ensureMediaDir() {
	await fs.mkdir(MEDIA_DIR, { recursive: true });
	return MEDIA_DIR;
}

export async function cleanOldMedia(ttlMs = DEFAULT_TTL_MS) {
	await ensureMediaDir();
	const entries = await fs.readdir(MEDIA_DIR).catch(() => []);
	const now = Date.now();
	await Promise.all(
		entries.map(async (file) => {
			const full = path.join(MEDIA_DIR, file);
			const stat = await fs.stat(full).catch(() => null);
			if (!stat) return;
			if (now - stat.mtimeMs > ttlMs) {
				await fs.rm(full).catch(() => {});
			}
		}),
	);
}

function looksLikeUrl(src: string) {
	return /^https?:\/\//i.test(src);
}

async function downloadToFile(url: string, dest: string) {
	await new Promise<void>((resolve, reject) => {
		const req = request(url, (res) => {
			if (!res.statusCode || res.statusCode >= 400) {
				reject(new Error(`HTTP ${res.statusCode ?? "?"} downloading media`));
				return;
			}
			let total = 0;
			const out = createWriteStream(dest);
			res.on("data", (chunk) => {
				total += chunk.length;
				if (total > MAX_BYTES) {
					req.destroy(new Error("Media exceeds 5MB limit"));
				}
			});
			pipeline(res, out).then(() => resolve()).catch(reject);
		});
		req.on("error", reject);
		req.end();
	});
}

export type SavedMedia = {
	id: string;
	path: string;
	size: number;
	contentType?: string;
};

export async function saveMediaSource(
	source: string,
): Promise<SavedMedia> {
	await ensureMediaDir();
	await cleanOldMedia();
	const id = crypto.randomUUID();
	const dest = path.join(MEDIA_DIR, id);
	if (looksLikeUrl(source)) {
		await downloadToFile(source, dest);
		const stat = await fs.stat(dest);
		return { id, path: dest, size: stat.size };
	}
	// local path
	const stat = await fs.stat(source);
	if (!stat.isFile()) {
		throw new Error("Media path is not a file");
	}
	if (stat.size > MAX_BYTES) {
		throw new Error("Media exceeds 5MB limit");
	}
	await fs.copyFile(source, dest);
	return { id, path: dest, size: stat.size };
}
