#!/usr/bin/env node
/**
 * Copies the unpacked OpenClaw Chrome extension into the browser plugin dist so
 * `openclaw browser extension path` resolves a stable location for
 * chrome://extensions "Load unpacked".
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = path.resolve(pluginDir, "../..");

const srcDir = process.env.OPENCLAW_CHROME_EXT_SRC_DIR ?? path.join(pluginDir, "chrome-extension");
const outDir =
  process.env.OPENCLAW_CHROME_EXT_OUT_DIR ??
  path.join(rootDir, "dist", "extensions", "browser", "chrome-extension");

async function pathExists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await pathExists(srcDir))) {
    if (
      process.env.OPENCLAW_SPARSE_PROFILE ||
      process.env.OPENCLAW_CHROME_EXT_SKIP_MISSING === "1"
    ) {
      return;
    }
    throw new Error(`Chrome extension source not found: ${srcDir}`);
  }
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(outDir), { recursive: true });
  // Ship only the runtime extension; colocated *.test.ts and *.d.ts stay out.
  await fs.cp(srcDir, outDir, {
    recursive: true,
    filter: (source) => !source.endsWith(".test.ts") && !source.endsWith(".d.ts"),
  });
}

try {
  await main();
} catch (err) {
  console.error(`[copy-chrome-extension] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
