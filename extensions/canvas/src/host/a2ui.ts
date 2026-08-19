/**
 * HTTP handler for serving bundled A2UI renderer assets.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleA2uiHttpRequestWithRootResolver } from "./a2ui-route.js";

export { A2UI_PATH, CANVAS_HOST_PATH } from "./a2ui-shared.js";

let cachedA2uiRootReal: string | null | undefined;
let resolvingA2uiRoot: Promise<string | null> | null = null;
let cachedA2uiResolvedAtMs = 0;
const A2UI_ROOT_RETRY_NULL_AFTER_MS = 10_000;

type A2uiHttpRequest = { method?: string; url?: string };
type A2uiHttpResponse = {
  statusCode: number;
  setHeader(name: string, value: number | string | readonly string[]): void;
  end(chunk?: Buffer | string): void;
};

async function resolveA2uiRoot(): Promise<string | null> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const entryDir = process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : null;
  const candidates = [
    // Running from source (bun) or a copied dist asset chunk.
    path.resolve(here, "a2ui"),
    // Running from dist root chunk (common launchd path).
    path.resolve(here, "canvas-host/a2ui"),
    // Entry path fallbacks (helps when cwd is not the repo root).
    ...(entryDir
      ? [path.resolve(entryDir, "a2ui"), path.resolve(entryDir, "canvas-host/a2ui")]
      : []),
    // Running from dist without copied assets (fallback to source).
    path.resolve(here, "../../extensions/canvas/src/host/a2ui"),
    path.resolve(here, "../extensions/canvas/src/host/a2ui"),
    // Running from repo root.
    path.resolve(process.cwd(), "extensions/canvas/src/host/a2ui"),
    path.resolve(process.cwd(), "dist/canvas-host/a2ui"),
  ];
  if (process.execPath) {
    candidates.unshift(path.resolve(path.dirname(process.execPath), "a2ui"));
  }

  for (const dir of candidates) {
    try {
      const bundlePath = path.join(dir, "a2ui.bundle.js");
      const v09BundlePath = path.join(dir, "a2ui-v0.9.bundle.js");
      await fs.stat(bundlePath);
      await fs.stat(v09BundlePath);
      return dir;
    } catch {
      // try next
    }
  }
  return null;
}

async function resolveA2uiRootReal(): Promise<string | null> {
  const nowMs = Date.now();
  if (
    cachedA2uiRootReal !== undefined &&
    (cachedA2uiRootReal !== null || nowMs - cachedA2uiResolvedAtMs < A2UI_ROOT_RETRY_NULL_AFTER_MS)
  ) {
    return cachedA2uiRootReal;
  }
  if (!resolvingA2uiRoot) {
    resolvingA2uiRoot = (async () => {
      const root = await resolveA2uiRoot();
      cachedA2uiRootReal = root ? await fs.realpath(root) : null;
      cachedA2uiResolvedAtMs = Date.now();
      resolvingA2uiRoot = null;
      return cachedA2uiRootReal;
    })();
  }
  return resolvingA2uiRoot;
}

/** Handles one HTTP request for the hosted A2UI asset surface. */
export async function handleA2uiHttpRequest(
  req: A2uiHttpRequest,
  res: A2uiHttpResponse,
): Promise<boolean> {
  return await handleA2uiHttpRequestWithRootResolver(req, res, resolveA2uiRootReal);
}
