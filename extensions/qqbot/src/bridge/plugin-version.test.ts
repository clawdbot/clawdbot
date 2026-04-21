/**
 * Tests for `resolveQQBotPluginVersion`.
 *
 * These exercise the directory-walk lookup against controlled fixture
 * trees rather than the repo's real `package.json`, so the behaviour
 * is deterministic regardless of where the test runs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QQBOT_PLUGIN_VERSION_UNKNOWN, resolveQQBotPluginVersion } from "./plugin-version.js";

/** Create a temp directory tree for an individual test and return its root. */
function createTempTree(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-pkg-version-"));
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data), "utf8");
}

function fakeEntryFileUrl(dir: string): string {
  const entryPath = path.join(dir, "gateway.ts");
  // File need not exist for `fileURLToPath` to work; the resolver
  // only uses its *parent directory* as the walk start point.
  return pathToFileURL(entryPath).href;
}

describe("resolveQQBotPluginVersion", () => {
  let tempRoots: string[] = [];

  beforeEach(() => {
    tempRoots = [];
  });

  afterEach(() => {
    for (const root of tempRoots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function newTree(): string {
    const root = createTempTree();
    tempRoots.push(root);
    return root;
  }

  it("returns the version from the nearest matching package.json", () => {
    const root = newTree();
    const pluginDir = path.join(root, "extensions", "qqbot");
    const bridgeDir = path.join(pluginDir, "src", "bridge");
    writeJson(path.join(pluginDir, "package.json"), {
      name: "@openclaw/qqbot",
      version: "2026.4.16",
    });
    fs.mkdirSync(bridgeDir, { recursive: true });

    const version = resolveQQBotPluginVersion(fakeEntryFileUrl(bridgeDir));

    expect(version).toBe("2026.4.16");
  });

  it("skips package.json files whose name field does not match", () => {
    const root = newTree();
    // Parent package.json belongs to the framework, not the plugin.
    writeJson(path.join(root, "package.json"), {
      name: "openclaw",
      version: "9.9.9",
    });
    const pluginDir = path.join(root, "extensions", "qqbot");
    const bridgeDir = path.join(pluginDir, "src", "bridge");
    writeJson(path.join(pluginDir, "package.json"), {
      name: "@openclaw/qqbot",
      version: "2026.4.16",
    });
    fs.mkdirSync(bridgeDir, { recursive: true });

    const version = resolveQQBotPluginVersion(fakeEntryFileUrl(bridgeDir));

    // Must stop at the plugin manifest, never bubble up to the framework one.
    expect(version).toBe("2026.4.16");
  });

  it("ignores manifests with unrelated name and returns unknown when no match is found", () => {
    const root = newTree();
    // Only an unrelated manifest exists up the tree.
    writeJson(path.join(root, "package.json"), {
      name: "some-other-package",
      version: "1.0.0",
    });
    const startDir = path.join(root, "extensions", "qqbot", "src", "bridge");
    fs.mkdirSync(startDir, { recursive: true });

    const version = resolveQQBotPluginVersion(fakeEntryFileUrl(startDir));

    expect(version).toBe(QQBOT_PLUGIN_VERSION_UNKNOWN);
  });

  it("returns unknown when no package.json exists above the start directory", () => {
    const root = newTree();
    const startDir = path.join(root, "extensions", "qqbot", "src", "bridge");
    fs.mkdirSync(startDir, { recursive: true });

    const version = resolveQQBotPluginVersion(fakeEntryFileUrl(startDir));

    expect(version).toBe(QQBOT_PLUGIN_VERSION_UNKNOWN);
  });

  it("returns unknown when the matching manifest lacks a version field", () => {
    const root = newTree();
    const pluginDir = path.join(root, "extensions", "qqbot");
    const bridgeDir = path.join(pluginDir, "src", "bridge");
    writeJson(path.join(pluginDir, "package.json"), {
      name: "@openclaw/qqbot",
      // version intentionally missing
    });
    fs.mkdirSync(bridgeDir, { recursive: true });

    const version = resolveQQBotPluginVersion(fakeEntryFileUrl(bridgeDir));

    expect(version).toBe(QQBOT_PLUGIN_VERSION_UNKNOWN);
  });

  it("tolerates a malformed package.json and keeps walking", () => {
    const root = newTree();
    const pluginDir = path.join(root, "extensions", "qqbot");
    const bridgeDir = path.join(pluginDir, "src", "bridge");
    // Broken manifest at the expected plugin location.
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "package.json"), "{ not valid json", "utf8");
    // Valid matching manifest higher up (unusual layout but still resolvable).
    writeJson(path.join(root, "package.json"), {
      name: "@openclaw/qqbot",
      version: "2026.9.9",
    });
    fs.mkdirSync(bridgeDir, { recursive: true });

    const version = resolveQQBotPluginVersion(fakeEntryFileUrl(bridgeDir));

    expect(version).toBe("2026.9.9");
  });
});
