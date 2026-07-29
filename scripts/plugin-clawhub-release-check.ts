#!/usr/bin/env -S node --import tsx
// Plugin Clawhub Release Check script supports OpenClaw repository automation.

import { pathToFileURL } from "node:url";
import {
  assertPluginReleaseDependencyFreshness,
  collectClawHubPublishablePluginPackages,
  collectClawHubVersionGateErrors,
  assertPluginReleaseVersionFloors,
  parsePluginReleaseArgs,
  resolveSelectedClawHubPublishablePluginPackages,
} from "./lib/plugin-clawhub-release.ts";
import type { NpmLatestVersionResolver } from "./lib/plugin-npm-release.ts";

export async function runPluginClawHubReleaseCheck(
  argv: string[],
  options: {
    rootDir?: string;
    resolveLatestVersion?: NpmLatestVersionResolver;
  } = {},
) {
  const { selection, selectionMode, baseRef, headRef } = parsePluginReleaseArgs(argv);
  const rootDir = options.rootDir ?? ".";
  const publishable = collectClawHubPublishablePluginPackages(rootDir, {
    packageNames:
      selectionMode === "all-publishable" || selection.length === 0 ? undefined : selection,
  });
  const gitRange = baseRef && headRef ? { baseRef, headRef } : undefined;
  const selected = resolveSelectedClawHubPublishablePluginPackages({
    plugins: publishable,
    selection,
    selectionMode,
    gitRange,
    rootDir,
  });

  if (selectionMode !== undefined || selection.length > 0) {
    assertPluginReleaseVersionFloors(selected, "plugin-clawhub-release-check");
  }
  assertPluginReleaseDependencyFreshness(
    selected,
    "plugin-clawhub-release-check",
    options.resolveLatestVersion,
  );

  if (gitRange) {
    const errors = collectClawHubVersionGateErrors({
      plugins: publishable,
      gitRange,
      rootDir,
    });
    if (errors.length > 0) {
      throw new Error(
        `plugin-clawhub-release-check: version bumps required before ClawHub publish:\n${errors
          .map((error) => `  - ${error}`)
          .join("\n")}`,
      );
    }
  }

  console.log("plugin-clawhub-release-check: publishable plugin metadata looks OK.");
  if (gitRange && selected.length === 0) {
    console.log(
      `  - no publishable plugin package changes detected between ${gitRange.baseRef} and ${gitRange.headRef}`,
    );
  }
  for (const plugin of selected) {
    console.log(
      `  - ${plugin.packageName}@${plugin.version} (${plugin.channel}, ${plugin.extensionId})`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runPluginClawHubReleaseCheck(process.argv.slice(2));
}
