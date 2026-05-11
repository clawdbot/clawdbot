import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  type ConfigDocBaselineEntry,
  flattenConfigDocBaselineEntries,
  renderConfigDocBaselineArtifacts,
  writeConfigDocBaselineArtifacts,
} from "./doc-baseline.js";

vi.mock("./doc-baseline.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doc-baseline.runtime.js")>();
  return {
    ...actual,
    collectBundledChannelConfigs: () => undefined,
  };
});

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

  function requireEntry(
    byPath: Map<string, ConfigDocBaselineEntry>,
    entryPath: string,
  ): ConfigDocBaselineEntry {
    const entry = byPath.get(entryPath);
    expect(entry).toBeDefined();
    if (!entry) {
      throw new Error(`expected config doc baseline entry for ${entryPath}`);
    }
    return entry;
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

    const gatewayToken = requireEntry(byPath, "gateway.auth.token");
    expect(gatewayToken.kind).toBe("core");
    expect(gatewayToken.sensitive).toBe(true);

    const telegramToken = requireEntry(byPath, "channels.telegram.botToken");
    expect(telegramToken.kind).toBe("channel");
    expect(telegramToken.sensitive).toBe(true);

    const twilioToken = requireEntry(byPath, "plugins.entries.voice-call.config.twilio.authToken");
    expect(twilioToken.kind).toBe("plugin");
    expect(twilioToken.sensitive).toBe(true);
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

    const discordEntry = requireEntry(byPath, "channels.discord");
    expect(discordEntry.label).toBe("Discord");
    expect(discordEntry.help).toBe("very well supported right now.");

    const msteamsEntry = requireEntry(byPath, "channels.msteams");
    expect(msteamsEntry.label).toBe("Microsoft Teams");
    expect(msteamsEntry.help).toBe("Teams SDK; enterprise support.");
    expect(msteamsEntry.label).not.toContain("@openclaw/");

    const matrixEntry = requireEntry(byPath, "channels.matrix");
    expect(matrixEntry.label).toBe("Matrix");
    expect(matrixEntry.help).toBe("open protocol; install the plugin to enable.");
    expect(matrixEntry.help).not.toContain("homeserver");
  });

  it("matches array help hints that still use [] notation", async () => {
    const byPath = await getSharedByPath();

    const keyPrefixEntry = requireEntry(byPath, "session.sendPolicy.rules.*.match.keyPrefix");
    expect(keyPrefixEntry.help).toContain(
      "prefer rawKeyPrefix when exact full-key matching is required",
    );
    expect(keyPrefixEntry.sensitive).toBe(false);
  });

  it("walks union branches for nested config keys", async () => {
    const byPath = await getSharedByPath();

    expect(requireEntry(byPath, "bindings.*").hasChildren).toBe(true);
    expect(requireEntry(byPath, "bindings.*.type").path).toBe("bindings.*.type");
    expect(requireEntry(byPath, "bindings.*.match.channel").path).toBe("bindings.*.match.channel");
    expect(requireEntry(byPath, "bindings.*.match.peer.id").path).toBe("bindings.*.match.peer.id");
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
