import { describe, expect, it } from "vitest";
import {
  assertConfigWriteAllowedInCurrentMode,
  ConfigReadOnlyError,
  NixModeConfigMutationError,
} from "./config-write-guard.js";

describe("config write policy", () => {
  it.each([undefined, "", "0", "true"])(
    "leaves writes enabled for OPENCLAW_CONFIG_READONLY=%s",
    (value) => {
      expect(() =>
        assertConfigWriteAllowedInCurrentMode({ env: { OPENCLAW_CONFIG_READONLY: value } }),
      ).not.toThrow();
    },
  );

  it("reports external management without Nix guidance", () => {
    const run = () =>
      assertConfigWriteAllowedInCurrentMode({
        env: { OPENCLAW_CONFIG_READONLY: "1" },
        configPath: "/managed/openclaw.json",
      });
    expect(run).toThrow(ConfigReadOnlyError);
    expect(run).toThrow("external deployment source");
    expect(run).toThrow("/managed/openclaw.json");
    expect(run).not.toThrow(/Nix|nix-openclaw/);
  });

  it.each([undefined, "0", "1"])(
    "preserves Nix policy and guidance with OPENCLAW_CONFIG_READONLY=%s",
    (value) => {
      expect(() =>
        assertConfigWriteAllowedInCurrentMode({
          env: { OPENCLAW_NIX_MODE: "1", OPENCLAW_CONFIG_READONLY: value },
        }),
      ).toThrow(NixModeConfigMutationError);
    },
  );
});
