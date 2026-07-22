// Verifies owner display hashing uses a dedicated secret and raw mode disables it.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureOwnerDisplaySecret, resolveOwnerDisplaySetting } from "./owner-display.js";

describe("resolveOwnerDisplaySetting", () => {
  it("always uses raw owner ids after hash configuration retirement", () => {
    const cfg = {
      commands: {
        ownerDisplay: "hash",
        ownerDisplaySecret: "  owner-secret  ",
      },
    } as OpenClawConfig;

    expect(resolveOwnerDisplaySetting(cfg)).toEqual({
      ownerDisplay: "raw",
      ownerDisplaySecret: undefined,
    });
  });

  it("disables owner hash secret when display mode is raw", () => {
    const cfg = {
      commands: {
        ownerDisplay: "raw",
        ownerDisplaySecret: "owner-secret", // pragma: allowlist secret
      },
    } as OpenClawConfig;

    expect(resolveOwnerDisplaySetting(cfg)).toEqual({
      ownerDisplay: "raw",
      ownerDisplaySecret: undefined,
    });
  });
});

describe("ensureOwnerDisplaySecret", () => {
  it("leaves retired hash configuration untouched without generating a secret", () => {
    const cfg = {
      commands: {
        ownerDisplay: "hash",
      },
    } as OpenClawConfig;

    const result = ensureOwnerDisplaySecret(cfg, () => "generated-owner-secret");
    expect(result.generatedSecret).toBeUndefined();
    expect(result.config.commands?.ownerDisplaySecret).toBeUndefined();
    expect(result.config.commands?.ownerDisplay).toBe("hash");
  });

  it("does nothing when a hash secret is already configured", () => {
    const cfg = {
      commands: {
        ownerDisplay: "hash",
        ownerDisplaySecret: "existing-owner-secret", // pragma: allowlist secret
      },
    } as OpenClawConfig;

    const result = ensureOwnerDisplaySecret(cfg, () => "generated-owner-secret");
    expect(result.generatedSecret).toBeUndefined();
    expect(result.config).toEqual(cfg);
  });
});
