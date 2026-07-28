#!/usr/bin/env node
/**
 * Copies bundled Canvas A2UI assets into the dist host asset directory.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = path.resolve(pluginDir, "../..");

function getA2uiPaths(env = process.env) {
  const srcDir = env.OPENCLAW_A2UI_SRC_DIR ?? path.join(pluginDir, "src", "host", "a2ui");
  const outDir = env.OPENCLAW_A2UI_OUT_DIR ?? path.join(rootDir, "dist", "canvas-host", "a2ui");
  return { srcDir, outDir };
}

function shouldSkipMissingA2uiAssets(env = process.env) {
  return env.OPENCLAW_A2UI_SKIP_MISSING === "1" || Boolean(env.OPENCLAW_SPARSE_PROFILE);
}

function isRelativeWithin(relPath) {
  return (
    relPath === "" ||
    (relPath !== ".." && !relPath.startsWith(`..${path.sep}`) && !path.isAbsolute(relPath))
  );
}

function pathsOverlap(leftDir, rightDir) {
  const left = path.resolve(leftDir);
  const right = path.resolve(rightDir);
  return (
    isRelativeWithin(path.relative(left, right)) || isRelativeWithin(path.relative(right, left))
  );
}

/** Copies A2UI assets, optionally tolerating missing bundles in sparse builds. */
export async function copyA2uiAssets({ srcDir, outDir }) {
  if (pathsOverlap(srcDir, outDir)) {
    throw new Error("A2UI source and output directories must not overlap.");
  }

  const skipMissing = shouldSkipMissingA2uiAssets(process.env);
  try {
    await fs.stat(path.join(srcDir, "index.html"));
    await fs.stat(path.join(srcDir, "a2ui.bundle.js"));
  } catch (err) {
    const message = 'Missing A2UI bundle assets. Run "pnpm canvas:a2ui:bundle" and retry.';
    if (skipMissing) {
      console.warn(
        `${message} Skipping copy because OPENCLAW_A2UI_SKIP_MISSING=1 or OPENCLAW_SPARSE_PROFILE is set.`,
      );
      return;
    }
    throw new Error(message, { cause: err });
  }
  await fs.mkdir(path.dirname(outDir), { recursive: true });
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.cp(srcDir, outDir, { recursive: true });
}

async function main() {
  const { srcDir, outDir } = getA2uiPaths();
  await copyA2uiAssets({ srcDir, outDir });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(
    /** @param {unknown} err */ (err) => {
      console.error(String(err));
      process.exit(1);
    },
  );
}
