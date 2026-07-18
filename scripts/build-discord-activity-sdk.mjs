#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { writeGeneratedTextAsset } from "./lib/generated-text-asset.mjs";

const modulePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(modulePath), "..");
const discordDir = path.join(repoRoot, "extensions/discord");
const outputPath = path.join(repoRoot, "extensions/discord/assets/embedded-app-sdk.mjs");

/** Builds the browser SDK bundle without rewriting an identical generated asset. */
export async function buildDiscordActivitySdk(params = {}) {
  const buildImpl = params.build ?? build;
  const targetPath = params.outputPath ?? outputPath;
  const result = await buildImpl({
    entryPoints: ["@discord/embedded-app-sdk"],
    absWorkingDir: discordDir,
    bundle: true,
    platform: "browser",
    target: "es2020",
    format: "esm",
    minify: true,
    legalComments: "none",
    outfile: targetPath,
    write: false,
  });

  const outputFile = result.outputFiles?.[0];
  if (!outputFile) {
    throw new Error("esbuild did not produce the Discord Embedded App SDK bundle");
  }

  return writeGeneratedTextAsset(targetPath, outputFile.text);
}

if (process.argv[1] === modulePath) {
  await buildDiscordActivitySdk();
}
