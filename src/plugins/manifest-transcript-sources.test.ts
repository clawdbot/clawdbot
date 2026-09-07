import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPluginManifest } from "./manifest.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function loadDescriptor(descriptor: unknown, declared = ["captions"]) {
  const root = tempDirs.make("manifest-transcript-sources-");
  fs.writeFileSync(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id: "fixture",
      configSchema: { type: "object" },
      contracts: { transcriptSourceProviders: declared },
      transcriptSources: { captions: descriptor },
    }),
  );
  const result = loadPluginManifest(root);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.manifest;
}

describe("manifest transcript source setup", () => {
  it("normalizes a declared source's static name and closed locator requirements", () => {
    expect(
      loadDescriptor({
        name: " Captions ",
        autoStart: {
          accountId: "optional",
          guildId: "required",
          channelId: "required",
          meetingUrl: "optional",
        },
      }),
    ).toHaveProperty("transcriptSources.captions", {
      name: "Captions",
      autoStart: {
        accountId: "optional",
        guildId: "required",
        channelId: "required",
        meetingUrl: "optional",
      },
    });
  });
  it("allows an explicit empty locator set and an attach-only source name", () => {
    expect(loadDescriptor({ name: "Captions", autoStart: {} })).toHaveProperty(
      "transcriptSources.captions.autoStart",
      {},
    );
    expect(loadDescriptor({ name: "Captions" })).toHaveProperty("transcriptSources.captions", {
      name: "Captions",
    });
  });
  it("does not advertise a descriptor owned by another plugin", () => {
    expect(
      loadDescriptor({ name: "Captions", autoStart: {} }, ["other"]).transcriptSources,
    ).toBeUndefined();
  });
  it.each([
    null,
    [],
    "yes",
    { channelId: "sometimes" },
    { channelId: "required", token: "required" },
  ])("does not turn malformed setup %j into offered partial setup", (autoStart) => {
    expect(
      loadDescriptor({ name: "Captions", autoStart }).transcriptSources?.captions?.autoStart,
    ).toBeUndefined();
  });
});
