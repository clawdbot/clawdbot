// Tokenjuice tests cover manifest plugin behavior.
import fs from "node:fs";
import { describe, expect, it } from "vitest";

type TokenjuicePluginManifest = {
  contracts?: {
    agentToolResultMiddleware?: string[];
  };
};

describe("tokenjuice package manifest", () => {
  it("declares runtime-neutral tool result middleware ownership in the manifest contract", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as TokenjuicePluginManifest;

    expect(manifest.contracts?.agentToolResultMiddleware).toEqual(["openclaw", "codex"]);
  });
});
