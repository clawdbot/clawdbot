#!/usr/bin/env -S node --import tsx

import { pathToFileURL } from "node:url";
import {
  collectClawHubPublishablePluginPackages,
  collectClawHubVersionGateErrors,
  parsePluginReleaseArgs,
  resolveSelectedClawHubPublishablePluginPackages,
} from "./lib/plugin-clawhub-release.ts";

export async function runPluginClawHubReleaseCheck(argv: string[]) {
  const { selection, selectionMode, baseRef, headRef } = parsePluginReleaseArgs(argv);
  const publishable = collectClawHubPublishablePluginPackages(".", {
    packageNames:
      selectionMode === "all-publishable" || selection.length === 0 ? undefined : selection,
  });
  const gitRange = baseRef && headRef ? { baseRef, headRef } : undefined;
  const selected = resolveSelectedClawHubPublishablePluginPackages({
    plugins: publishable,
    selection,
    selectionMode,
    gitRange,
  });

  if (gitRange) {
    const errors = collectClawHubVersionGateErrors({
      plugins: publishable,
      gitRange,
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
