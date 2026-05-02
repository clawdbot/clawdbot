import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  type ConfigDocBaselineEntry,
  flattenConfigDocBaselineEntries,
  renderConfigDocBaselineArtifacts,
  writeConfigDocBaselineArtifacts,
} from "./doc-baseline.js";

describe("config doc baseline integration", () => {
  let sharedRenderedPromise: Promise<
    Awaited<ReturnType<typeof renderConfigDocBaselineArtifacts>>
  > | null = null;
  let sharedByPathPromise: Promise<Map<string, ConfigDocBaselineEntry>> | null = null;

  function getSharedRendered() {
    sharedRenderedPromise ??= renderConfigDocBaselineArtifacts();
    return sharedRenderedPromise;
  }

  function getSharedByPath() {
    sharedByPathPromise ??= getSharedRendered().then(
      ({ baseline }) =>
        new Map(flattenConfigDocBaselineEntries(baseline).map((entry) => [entry.path, entry])),
    );
    return sharedByPathPromise;
  }

  it("is deterministic across repeated runs", async () => {
    const first = await getSharedRendered();
    const { baseline } = first;
    const second = await renderConfigDocBaselineArtifacts(baseline);

    expect(second.json.combined).toBe(first.json.combined);
    expect(second.json.core).toBe(first.json.core);
    expect(second.json.channel).toBe(first.json.channel);
    expect(second.json.plugin).toBe(first.json.plugin);
  }, 240_000);

  it("includes core, channel, and plugin config metadata", async () => {
    const byPath = await getSharedByPath();

    expect(byPath.get("gateway.auth.token")).toMatchObject({
      kind: "core",
      sensitive: true,
    });
    expect(byPath.get("channels.telegram.botToken")).toMatchObject({
      kind: "channel",
      sensitive: true,
    });
    expect(byPath.get("plugins.entries.voice-call.config.twilio.authToken")).toMatchObject({
      kind: "plugin",
      sensitive: true,
    });
  });

  it("preserves help text and tags from merged schema hints", async () => {
    const byPath = await getSharedByPath();
    const tokenEntry = byPath.get("gateway.auth.token");

    expect(tokenEntry?.help).toContain("gateway access");
    expect(tokenEntry?.tags).toContain("auth");
    expect(tokenEntry?.tags).toContain("security");
  });

  it("omits legacy hooks.internal.handlers from the generated baseline", async () => {
    const byPath = await getSharedByPath();

    expect(byPath.get("hooks.internal.handlers")).toBeUndefined();
    expect(byPath.get("hooks.internal.handlers.*.module")).toBeUndefined();
  });

  it("uses human-readable channel metadata for top-level channel sections", async () => {
    const byPath = await getSharedByPath();

    expect(byPath.get("channels.discord")).toMatchObject({
      label: "Discord",
      help: "very well supported right now.",
    });
    expect(byPath.get("channels.msteams")).toMatchObject({
      label: "Microsoft Teams",
      help: "Teams SDK; enterprise support.",
    });
    expect(byPath.get("channels.matrix")).toMatchObject({
      label: "Matrix",
      help: "open protocol; install the plugin to enable.",
    });
    expect(byPath.get("channels.msteams")?.label).not.toContain("@openclaw/");
    expect(byPath.get("channels.matrix")?.help).not.toContain("homeserver");
  });

  it("matches array help hints that still use [] notation", async () => {
    const byPath = await getSharedByPath();

    expect(byPath.get("session.sendPolicy.rules.*.match.keyPrefix")).toMatchObject({
      help: expect.stringContaining("prefer rawKeyPrefix when exact full-key matching is required"),
      sensitive: false,
    });
  });

  it("walks union branches for nested config keys", async () => {
    const byPath = await getSharedByPath();

    expect(byPath.get("bindings.*")).toMatchObject({
      hasChildren: true,
    });
    expect(byPath.get("bindings.*.type")).toBeDefined();
    expect(byPath.get("bindings.*.match.channel")).toBeDefined();
    expect(byPath.get("bindings.*.match.peer.id")).toBeDefined();
  });

  it("supports check mode for stale hash files", async () => {
    await withTempDir({ prefix: "openclaw-config-doc-baseline-" }, async (tempRoot) => {
      const rendered = getSharedRendered();

      const initial = await writeConfigDocBaselineArtifacts({
        repoRoot: tempRoot,
        rendered,
      });
      expect(initial.wrote).toBe(true);

      const current = await writeConfigDocBaselineArtifacts({
        repoRoot: tempRoot,
        check: true,
        rendered,
      });
      expect(current.changed).toBe(false);

      // Corrupt the hash file to simulate drift
      await fs.writeFile(
        path.join(tempRoot, "docs/.generated/config-baseline.sha256"),
        "0000000000000000000000000000000000000000000000000000000000000000  config-baseline.json\n",
        "utf8",
      );

      const stale = await writeConfigDocBaselineArtifacts({
        repoRoot: tempRoot,
        check: true,
        rendered,
      });
      expect(stale.changed).toBe(true);
      expect(stale.wrote).toBe(false);
    });
  });
});
