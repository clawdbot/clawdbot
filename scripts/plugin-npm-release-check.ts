#!/usr/bin/env -S node --import tsx

import { pathToFileURL } from "node:url";
import {
  collectChangedExtensionIdsFromGitRange,
  collectPublishablePluginPackages,
  parsePluginReleaseArgs,
  resolveChangedPublishablePluginPackages,
  resolveSelectedPublishablePluginPackages,
} from "./lib/plugin-npm-release.ts";

export function runPluginNpmReleaseCheck(argv: string[]) {
  const { selection, selectionMode, baseRef, headRef } = parsePluginReleaseArgs(argv);
  const changedExtensionIds =
    baseRef && headRef
      ? collectChangedExtensionIdsFromGitRange({
          gitRange: { baseRef, headRef },
        })
      : [];
  const publishable = collectPublishablePluginPackages(".", {
    extensionIds:
      selectionMode === "all-publishable" || !(baseRef && headRef)
        ? undefined
        : changedExtensionIds,
    packageNames: selection.length > 0 ? selection : undefined,
  });
  const selected =
    selectionMode === "all-publishable"
      ? publishable
      : selection.length > 0
        ? resolveSelectedPublishablePluginPackages({
            plugins: publishable,
            selection,
          })
        : baseRef && headRef
          ? resolveChangedPublishablePluginPackages({
              plugins: publishable,
              changedExtensionIds,
            })
          : publishable;

  console.log("plugin-npm-release-check: publishable plugin metadata looks OK.");
  if (baseRef && headRef && selected.length === 0) {
    console.log(
      `  - no publishable plugin package changes detected between ${baseRef} and ${headRef}`,
    );
  }
  for (const plugin of selected) {
    console.log(
      `  - ${plugin.packageName}@${plugin.version} (${plugin.channel}, ${plugin.extensionId})`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runPluginNpmReleaseCheck(process.argv.slice(2));
}
