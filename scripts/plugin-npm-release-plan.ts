#!/usr/bin/env -S node --import tsx
// Plugin Npm Release Plan script supports OpenClaw repository automation.

import { pathToFileURL } from "node:url";
import { collectPluginReleasePlan, parsePluginReleaseArgs } from "./lib/plugin-npm-release.ts";

export function collectPluginNpmReleasePlan(argv: string[]) {
  const { selection, selectionMode, baseRef, headRef } = parsePluginReleaseArgs(argv);
  return collectPluginReleasePlan({
    selection,
    selectionMode,
    gitRange: baseRef && headRef ? { baseRef, headRef } : undefined,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const plan = collectPluginNpmReleasePlan(process.argv.slice(2));
  console.log(JSON.stringify(plan, null, 2));
}
