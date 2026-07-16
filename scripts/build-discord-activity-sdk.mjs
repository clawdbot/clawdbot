#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const modulePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(modulePath), "..");
const discordDir = path.join(repoRoot, "extensions/discord");
const outputPath = path.join(repoRoot, "extensions/discord/assets/embedded-app-sdk.mjs");

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await build({
  entryPoints: ["@discord/embedded-app-sdk"],
  absWorkingDir: discordDir,
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "esm",
  minify: true,
  legalComments: "none",
  outfile: outputPath,
});
