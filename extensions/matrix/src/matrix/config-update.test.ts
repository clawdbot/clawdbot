import { describe, expect, it } from "vitest";
import type { CoreConfig } from "../types.js";
import { resolveMatrixConfigFieldPath, updateMatrixAccountConfig } from "./config-update.js";

describe("updateMatrixAccountConfig", () => {
  it("resolves account-aware Matrix config field paths", () => {
    expect(resolveMatrixConfigFieldPath({} as CoreConfig, "default", "dm.policy")).toBe(
      "channels.matrix.dm.policy",
    );

    const cfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {},
          },
        },
      },
    } as CoreConfig;

    expect(resolveMatrixConfigFieldPath(cfg, "ops", ".dm.allowFrom")).toBe(
      "channels.matrix.accounts.ops.dm.allowFrom",
    );
  });

  it("supports explicit null clears and boolean false values", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            default: {
              homeserver: "https://matrix.example.org",
              userId: "@bot:example.org",
              accessToken: "old-token", // pragma: allowlist secret
              password: "old-password", // pragma: allowlist secret
              encryption: true,
            },
          },
        },
      },
    } as CoreConfig;

    const updated = updateMatrixAccountConfig(cfg, "default", {
      accessToken: "new-token",
      password: null,
      userId: null,
      encryption: false,
    });

    const account = updated.channels?.["matrix"]?.accounts?.default;
    expect(account?.accessToken).toBe("new-token");
    expect(account?.encryption).toBe(false);
    expect(account?.password).toBeUndefined();
    expect(account?.userId).toBeUndefined();
  });

  it("preserves SecretRef auth inputs when updating config", () => {
    const updated = updateMatrixAccountConfig({} as CoreConfig, "default", {
      accessToken: { source: "env", provider: "default", id: "MATRIX_ACCESS_TOKEN" },
      password: { source: "env", provider: "default", id: "MATRIX_PASSWORD" },
    });

    expect(updated.channels?.matrix?.accessToken).toEqual({
      source: "env",
      provider: "default",
      id: "MATRIX_ACCESS_TOKEN",
    });
    expect(updated.channels?.matrix?.password).toEqual({
      source: "env",
      provider: "default",
      id: "MATRIX_PASSWORD",
    });
  });

  it("stores and clears Matrix allowBots, allowPrivateNetwork, and proxy settings", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            default: {
              allowBots: true,
              network: {
                dangerouslyAllowPrivateNetwork: true,
              },
              proxy: "http://127.0.0.1:7890",
            },
          },
        },
      },
    } as CoreConfig;

    const updated = updateMatrixAccountConfig(cfg, "default", {
      allowBots: "mentions",
      allowPrivateNetwork: null,
      proxy: null,
    });

    const account = updated.channels?.["matrix"]?.accounts?.default;
    expect(account?.allowBots).toBe("mentions");
    expect(account?.network).toBeUndefined();
    expect(account?.proxy).toBeUndefined();
  });

  it("stores and clears Matrix invite auto-join settings", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            default: {
              autoJoin: "allowlist",
              autoJoinAllowlist: ["#ops:example.org"],
            },
          },
        },
      },
    } as CoreConfig;

    const allowlistUpdated = updateMatrixAccountConfig(cfg, "default", {
      autoJoin: "allowlist",
      autoJoinAllowlist: ["!ops-room:example.org", "#ops:example.org"],
    });
    const allowlistAccount = allowlistUpdated.channels?.matrix?.accounts?.default;
    expect(allowlistAccount?.autoJoin).toBe("allowlist");
    expect(allowlistAccount?.autoJoinAllowlist).toEqual([
      "!ops-room:example.org",
      "#ops:example.org",
    ]);

    const offUpdated = updateMatrixAccountConfig(cfg, "default", {
      autoJoin: "off",
      autoJoinAllowlist: null,
    });
    expect(offUpdated.channels?.matrix?.accounts?.default?.autoJoin).toBe("off");
    expect(offUpdated.channels?.matrix?.accounts?.default?.autoJoinAllowlist).toBeUndefined();

    const alwaysUpdated = updateMatrixAccountConfig(cfg, "default", {
      autoJoin: "always",
      autoJoinAllowlist: null,
    });
    expect(alwaysUpdated.channels?.matrix?.accounts?.default?.autoJoin).toBe("always");
    expect(alwaysUpdated.channels?.matrix?.accounts?.default?.autoJoinAllowlist).toBeUndefined();
  });

  it("normalizes account id and defaults account enabled=true", () => {
    const updated = updateMatrixAccountConfig({} as CoreConfig, "Main Bot", {
      name: "Main Bot",
      homeserver: "https://matrix.example.org",
    });

    const account = updated.channels?.["matrix"]?.accounts?.["main-bot"];
    expect(account?.name).toBe("Main Bot");
    expect(account?.homeserver).toBe("https://matrix.example.org");
    expect(account?.enabled).toBe(true);
  });

  it("updates nested access config for named accounts without touching top-level defaults", () => {
    const cfg = {
      channels: {
        matrix: {
          dm: {
            policy: "pairing",
          },
          groups: {
            "!default:example.org": { enabled: true },
          },
          accounts: {
            ops: {
              homeserver: "https://matrix.ops.example.org",
              accessToken: "ops-token",
              dm: {
                enabled: true,
                policy: "pairing",
              },
            },
          },
        },
      },
    } as CoreConfig;

    const updated = updateMatrixAccountConfig(cfg, "ops", {
      dm: {
        policy: "allowlist",
        allowFrom: ["@alice:example.org"],
      },
      groupPolicy: "allowlist",
      groups: {
        "!ops-room:example.org": { enabled: true },
      },
      rooms: null,
    });

    expect(updated.channels?.["matrix"]?.dm?.policy).toBe("pairing");
    expect(updated.channels?.["matrix"]?.groups).toEqual({
      "!default:example.org": { enabled: true },
    });
    const account = updated.channels?.["matrix"]?.accounts?.ops;
    expect(account?.dm).toEqual({
      enabled: true,
      policy: "allowlist",
      allowFrom: ["@alice:example.org"],
    });
    expect(account?.groupPolicy).toBe("allowlist");
    expect(account?.groups).toEqual({
      "!ops-room:example.org": { enabled: true },
    });
    expect(account?.rooms).toBeUndefined();
  });

  it("reuses and canonicalizes non-normalized account entries when updating", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            Ops: {
              homeserver: "https://matrix.ops.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    } as CoreConfig;

    const updated = updateMatrixAccountConfig(cfg, "ops", {
      deviceName: "Ops Bot",
    });

    expect(updated.channels?.["matrix"]?.accounts?.Ops).toBeUndefined();
    const account = updated.channels?.["matrix"]?.accounts?.ops;
    expect(account?.homeserver).toBe("https://matrix.ops.example.org");
    expect(account?.accessToken).toBe("ops-token");
    expect(account?.deviceName).toBe("Ops Bot");
    expect(account?.enabled).toBe(true);
  });
});
