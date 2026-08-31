#!/usr/bin/env -S node --import tsx
// Regenerates ui/config/control-ui-boot-modules.json: the measured module set
// the default Control UI boot flow loads lazily. Builds without the previous
// boot group, then captures Chat-ready chunk sources against the mocked Gateway.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "vite";
import {
  controlUiBootManifestKey,
  controlUiCodeSplitting,
} from "../ui/config/control-ui-chunking.ts";
import { installMockGateway } from "../ui/src/test-helpers/control-ui-e2e.ts";
import controlUiViteConfig from "../ui/vite.config.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "ui", "config", "control-ui-boot-modules.json");
const SETTLE_MS = 3_000;
const READY_TIMEOUT_MS = 60_000;

const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
};

function serveDist(distDir: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const urlPath = new URL(req.url ?? "/", "http://localhost").pathname;
    if (urlPath === "/control-ui-config.json") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ basePath: "/", assistantName: "", assistantAvatar: "" }));
      return;
    }
    let filePath = path.join(distDir, urlPath === "/" ? "index.html" : urlPath.slice(1));
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(distDir, "index.html");
    }
    res.setHeader("Content-Type", mime[path.extname(filePath)] ?? "application/octet-stream");
    res.end(fs.readFileSync(filePath));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address !== "object") {
        throw new Error("Control UI boot manifest server has no port");
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
          }),
      });
    });
  });
}

function readDistBuildId(distDir: string): string {
  const swSource = fs.readFileSync(path.join(distDir, "sw.js"), "utf8");
  const buildId = /EMBEDDED_CACHE_VERSION = "([^"]+)"/.exec(swSource)?.[1];
  if (!buildId) {
    throw new Error("Control UI boot manifest cannot read the dist build id from sw.js");
  }
  return buildId;
}

async function collectBootChunkPaths(baseUrl: string, distDir: string): Promise<Set<string>> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const chunkPaths = new Set<string>();
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith("/assets/") && pathname.endsWith(".js")) {
        chunkPaths.add(pathname);
      }
    });
    await installMockGateway(page, { serverBuildId: readDistBuildId(distDir) });
    await page.goto(`${baseUrl}/chat`, { waitUntil: "commit" });
    // Chat readiness proves the boot flow completed instead of stalling on an
    // error surface; a manifest captured from a broken boot would be garbage.
    await page
      .locator(".agent-chat__composer-combobox textarea")
      .waitFor({ timeout: READY_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
    return chunkPaths;
  } finally {
    await browser.close();
  }
}

function manifestKeysForChunks(chunkPaths: Iterable<string>, distDir: string): string[] {
  const keys = new Set<string>();
  for (const chunkPath of chunkPaths) {
    const mapPath = path.join(distDir, `${chunkPath}.map`);
    if (!fs.existsSync(mapPath)) {
      // Facade chunks for dynamic entries can omit maps; their modules are
      // covered by the chunks that carry the actual code.
      continue;
    }
    const map = JSON.parse(fs.readFileSync(mapPath, "utf8")) as { sources?: string[] };
    for (const source of map.sources ?? []) {
      keys.add(controlUiBootManifestKey(path.resolve(path.join(distDir, "assets"), source)));
    }
  }
  return [...keys].toSorted();
}

async function main(): Promise<void> {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-control-ui-boot-"));
  try {
    const config = controlUiViteConfig({ outDir: distDir });
    await build({
      ...config,
      configFile: false,
      root: path.join(repoRoot, "ui"),
      plugins: [
        config.plugins,
        {
          name: "control-ui-measure-boot-dependencies",
          outputOptions(options) {
            // The old boot group would keep stale modules in fetched chunks,
            // feeding them back into every regenerated manifest.
            return {
              ...options,
              codeSplitting: {
                ...controlUiCodeSplitting,
                groups: controlUiCodeSplitting.groups.filter(
                  (group) => group.name !== "control-ui-boot",
                ),
              },
            };
          },
        },
      ],
    });
    const server = await serveDist(distDir);
    try {
      const chunkPaths = await collectBootChunkPaths(server.baseUrl, distDir);
      const keys = manifestKeysForChunks(chunkPaths, distDir);
      if (keys.length < 100) {
        throw new Error(`Boot capture looks truncated: only ${keys.length} modules recorded`);
      }
      fs.writeFileSync(manifestPath, `${JSON.stringify(keys, null, 1)}\n`);
      console.log(
        `control-ui-boot-manifest: ${chunkPaths.size} boot chunks -> ${keys.length} modules -> ${path.relative(repoRoot, manifestPath)}`,
      );
    } finally {
      await server.close();
    }
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  console.error("[control-ui-boot-manifest] FAILED (exit 1)");
  process.exit(1);
});
