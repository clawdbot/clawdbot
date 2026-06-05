// Verifies owner display hashing uses a dedicated secret and raw mode disables it.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureOwnerDisplaySecret, resolveOwnerDisplaySetting } from "./owner-display.js";

describe("resolveOwnerDisplaySetting", () => {
  it("returns keyed hash settings when hash mode has an explicit secret", () => {
    const cfg = {
      commands: {
        ownerDisplay: "hash",
        ownerDisplaySecret: "  owner-secret  ",
      },
    } as OpenClawConfig;

    expect(resolveOwnerDisplaySetting(cfg)).toEqual({
      ownerDisplay: "hash",
      ownerDisplaySecret: "owner-secret", // pragma: allowlist secret
    });
  });

  it("does not fall back to gateway tokens when hash secret is missing", () => {
    // Gateway auth tokens are unrelated secrets and must never seed owner hashes.
    const cfg = {
      commands: {
        ownerDisplay: "hash",
      },
      gateway: {
        auth: { token: "gateway-auth-token" },
        remote: { token: "gateway-remote-token" },
      },
    } as OpenClawConfig;

    expect(resolveOwnerDisplaySetting(cfg)).toEqual({
      ownerDisplay: "hash",
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
  it("generates a dedicated secret when hash mode is enabled without one", () => {
    const cfg = {
      commands: {
        ownerDisplay: "hash",
      },
    } as OpenClawConfig;

    const result = ensureOwnerDisplaySecret(cfg, () => "generated-owner-secret");
    expect(result.generatedSecret).toBe("generated-owner-secret");
    expect(result.config.commands?.ownerDisplaySecret).toBe("generated-owner-secret");
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
