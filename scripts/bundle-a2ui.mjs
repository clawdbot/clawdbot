#!/usr/bin/env node

// Runs bundled asset build hooks for the Canvas A2UI runtime.
import { pathToFileURL } from "node:url";
import { runBundledPluginAssetHooks } from "./bundled-plugin-assets.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runBundledPluginAssetHooks({ phase: "build", plugins: ["canvas"] });
}
