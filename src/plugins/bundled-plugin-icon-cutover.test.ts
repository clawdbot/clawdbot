// These bundled packages lack legacy Control UI artwork, so their local assets
// must keep them branded when top-level icon URLs are ignored.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pluginTestRepoRoot as repoRoot } from "./generated-plugin-test-helpers.js";

const CUTOVER_BRIDGE_PLUGIN_IDS = ["teams-meetings", "zoom-meetings"] as const;

describe("bundled plugin icon cutover", () => {
  it.each(CUTOVER_BRIDGE_PLUGIN_IDS)("keeps %s branded from its package asset", (pluginId) => {
    const icon = fs.readFileSync(path.join(repoRoot, "extensions", pluginId, "assets", "icon.png"));
    expect(icon.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(icon.readUInt32BE(16)).toBe(512);
    expect(icon.readUInt32BE(20)).toBe(512);
  });
});
