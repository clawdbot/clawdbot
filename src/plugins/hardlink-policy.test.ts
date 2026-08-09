// Verifies plugin hardlink policy decisions.
import { describe, expect, it } from "vitest";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";

const nixEnv: NodeJS.ProcessEnv = { OPENCLAW_NIX_MODE: "1" };

describe("plugin hardlink policy", () => {
  it("does not reject bundled plugin files", () => {
    expect(
      shouldRejectHardlinkedPluginFiles({
        origin: "bundled",
        rootDir: "/tmp/plugin",
        env: {},
      }),
    ).toBe(false);
  });

  it("rejects hardlinked external plugin files by default", () => {
    expect(
      shouldRejectHardlinkedPluginFiles({
        origin: "config",
        rootDir: "/tmp/plugin",
        env: {},
      }),
    ).toBe(true);
  });

  it("does not treat OPENCLAW_NIX_MODE as enough by itself", () => {
    expect(
      shouldRejectHardlinkedPluginFiles({
        origin: "config",
        rootDir: "/tmp/plugin",
        env: nixEnv,
      }),
    ).toBe(true);
  });
});
