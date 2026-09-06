#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
function add(collected, id, value, source) {
  if (!id || !value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const encoded = JSON.stringify(value);
  const previous = collected.get(id);
  if (previous && previous.encoded !== encoded) {
    throw new Error(`Conflicting initial config defaults for ${id}: ${previous.source}, ${source}`);
  }
  collected.set(id, { encoded, source, value });
}
export function collectInitialPluginConfigDefaults({ bundledManifests, officialEntries }) {
  const collected = new Map();
  for (const { manifest, source } of bundledManifests) {
    add(collected, manifest.id, manifest.configContracts?.initialConfigDefaults, source);
  }
  for (const { entry, source } of officialEntries) {
    if (entry.source !== "official") {
      continue;
    }
    add(
      collected,
      entry.openclaw?.plugin?.id,
      entry.openclaw?.configContracts?.initialConfigDefaults,
      source,
    );
  }
  return Object.fromEntries(
    [...collected].toSorted(([a], [b]) => a.localeCompare(b)).map(([id, item]) => [id, item.value]),
  );
}

function generate() {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const check = process.argv.includes("--check");
  if (check && process.argv.includes("--write")) {
    throw new Error("Use either --check or --write");
  }
  const bundledManifests = [];
  const officialEntries = [];
  const extensionsDir = path.join(repoRoot, "extensions");
  for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const file = path.join(extensionsDir, entry.name, "openclaw.plugin.json");
    if (!fs.existsSync(file)) {
      continue;
    }
    const manifest = readJson(file);
    bundledManifests.push({ manifest, source: path.relative(repoRoot, file) });
  }
  for (const name of [
    "official-external-channel-catalog.json",
    "official-external-provider-catalog.json",
    "official-external-plugin-catalog.json",
  ]) {
    const file = path.join(repoRoot, "scripts/lib", name);
    for (const entry of readJson(file).entries ?? []) {
      officialEntries.push({ entry, source: path.relative(repoRoot, file) });
    }
  }
  const defaults = collectInitialPluginConfigDefaults({ bundledManifests, officialEntries });
  const json = `${JSON.stringify(defaults, null, 2)}\n`;
  const swiftLiteral = JSON.stringify(defaults).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const swift = `// Generated file. Do not edit directly.
// Source: plugin configContracts.initialConfigDefaults in bundled/official declarations.
// Regenerate: node scripts/generate-initial-plugin-config-defaults.mjs --write

import Foundation

public enum InitialPluginConfigDefaults {
    private static let encoded = "${swiftLiteral}"

    public static func applying(to root: [String: Any], ifCreatingFileAt url: URL) -> [String: Any] {
        do {
            _ = try FileManager().attributesOfItem(atPath: url.path)
            return root
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            return applying(to: root)
        } catch {
            // An unreadable or otherwise uncertain existing config is not a fresh install.
            return root
        }
    }

    public static func applying(to root: [String: Any]) -> [String: Any] {
        guard let data = encoded.data(using: .utf8),
              let defaults = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return root }
        var output = root
        guard output["plugins"] == nil || output["plugins"] is [String: Any] else { return output }
        var plugins = output["plugins"] as? [String: Any] ?? [:]
        guard plugins["entries"] == nil || plugins["entries"] is [String: Any] else { return output }
        var entries = plugins["entries"] as? [String: Any] ?? [:]
        for (pluginId, rawDefaults) in defaults {
            guard let pluginDefaults = rawDefaults as? [String: Any] else { continue }
            guard entries[pluginId] == nil || entries[pluginId] is [String: Any] else { continue }
            var entry = entries[pluginId] as? [String: Any] ?? [:]
            guard entry["config"] == nil || entry["config"] is [String: Any] else { continue }
            let existing = entry["config"] as? [String: Any] ?? [:]
            entry["config"] = mergeMissing(existing: existing, defaults: pluginDefaults)
            entries[pluginId] = entry
        }
        plugins["entries"] = entries
        output["plugins"] = plugins
        return output
    }

    private static func mergeMissing(existing: [String: Any], defaults: [String: Any]) -> [String: Any] {
        var output = existing
        for (key, value) in defaults where !output.keys.contains(key) { output[key] = value }
        for (key, value) in defaults {
            guard let nestedDefaults = value as? [String: Any],
                  let nestedExisting = output[key] as? [String: Any]
            else { continue }
            output[key] = mergeMissing(existing: nestedExisting, defaults: nestedDefaults)
        }
        return output
    }
}
`;
  const outputs = new Map([
    [path.join(repoRoot, "src/plugins/initial-config-defaults.generated.json"), json],
    [
      path.join(
        repoRoot,
        "apps/shared/OpenClawKit/Sources/OpenClawKit/InitialPluginConfigDefaults.generated.swift",
      ),
      swift,
    ],
  ]);
  let stale = false;
  for (const [file, content] of outputs) {
    if ((fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null) === content) {
      continue;
    }
    stale = true;
    if (!check) {
      fs.writeFileSync(file, content);
    }
    console.error(`${check ? "Out of date" : "Wrote"} ${path.relative(repoRoot, file)}`);
  }
  if (check && stale) {
    process.exit(1);
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  generate();
}
