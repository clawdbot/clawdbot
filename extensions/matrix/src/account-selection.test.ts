import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  findMatrixAccountEntry,
  requiresExplicitMatrixDefaultAccount,
  resolveConfiguredMatrixAccountIds,
  resolveMatrixDefaultOrOnlyAccountId,
} from "./account-selection.js";
import { getMatrixScopedEnvVarNames } from "./env-vars.js";

describe("matrix account selection", () => {
  it("resolves configured account ids from non-canonical account keys", () => {
    const cfg: OpenClawConfig = {
      channels: {
        matrix: {
          accounts: {
            "Team Ops": { homeserver: "https://matrix.example.org" },
          },
        },
      },
    };

    expect(resolveConfiguredMatrixAccountIds(cfg)).toEqual(["team-ops"]);
    expect(resolveMatrixDefaultOrOnlyAccountId(cfg)).toBe("team-ops");
  });

  it("matches the default account against normalized Matrix account keys", () => {
    const cfg: OpenClawConfig = {
      channels: {
        matrix: {
          defaultAccount: "Team Ops",
          accounts: {
            "Ops Bot": { homeserver: "https://matrix.example.org" },
            "Team Ops": { homeserver: "https://matrix.example.org" },
          },
        },
      },
    };

    expect(resolveMatrixDefaultOrOnlyAccountId(cfg)).toBe("team-ops");
    expect(requiresExplicitMatrixDefaultAccount(cfg)).toBe(false);
  });

  it("requires an explicit default when multiple Matrix accounts exist without one", () => {
    const cfg: OpenClawConfig = {
      channels: {
        matrix: {
          accounts: {
            ops: { homeserver: "https://matrix.example.org" },
            alerts: { homeserver: "https://matrix.example.org" },
          },
        },
      },
    };

    expect(requiresExplicitMatrixDefaultAccount(cfg)).toBe(true);
  });

  it('uses a named "default" Matrix account when defaultAccount is unset', () => {
    const cfg: OpenClawConfig = {
      channels: {
        matrix: {
          accounts: {
            default: { homeserver: "https://matrix.example.org" },
            ops: { homeserver: "https://matrix.example.org" },
          },
        },
      },
    };

    expect(resolveMatrixDefaultOrOnlyAccountId(cfg)).toBe("default");
    expect(requiresExplicitMatrixDefaultAccount(cfg)).toBe(false);
  });

  it("finds the raw Matrix account entry by normalized account id", () => {
    const cfg: OpenClawConfig = {
      channels: {
        matrix: {
          accounts: {
            "Team Ops": {
              homeserver: "https://matrix.example.org",
              userId: "@ops:example.org",
            },
          },
        },
      },
    };

    expect(findMatrixAccountEntry(cfg, "team-ops")).toEqual({
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
    });
  });

  it("discovers env-backed named Matrix accounts during enumeration", () => {
    const keys = getMatrixScopedEnvVarNames("team-ops");
    const cfg: OpenClawConfig = {
      channels: {
        matrix: {},
      },
    };
    const env = {
      [keys.homeserver]: "https://matrix.example.org",
      [keys.accessToken]: "secret",
    } satisfies NodeJS.ProcessEnv;

    expect(resolveConfiguredMatrixAccountIds(cfg, env)).toEqual(["team-ops"]);
    expect(resolveMatrixDefaultOrOnlyAccountId(cfg, env)).toBe("team-ops");
    expect(requiresExplicitMatrixDefaultAccount(cfg, env)).toBe(false);
  });

  it('uses the "default" Matrix account when mixed default and named env-backed accounts exist', () => {
    const keys = getMatrixScopedEnvVarNames("team-ops");
    const cfg: OpenClawConfig = {
      channels: {
        matrix: {},
      },
    };
    const env = {
      MATRIX_HOMESERVER: "https://matrix.example.org",
      MATRIX_ACCESS_TOKEN: "default-secret",
      [keys.homeserver]: "https://matrix.example.org",
      [keys.accessToken]: "team-secret",
    } satisfies NodeJS.ProcessEnv;

    expect(resolveConfiguredMatrixAccountIds(cfg, env)).toEqual(["default", "team-ops"]);
    expect(resolveMatrixDefaultOrOnlyAccountId(cfg, env)).toBe("default");
    expect(requiresExplicitMatrixDefaultAccount(cfg, env)).toBe(false);
  });

  it("discovers default Matrix accounts backed only by global env vars", () => {
    const cfg: OpenClawConfig = {};
    const env = {
      MATRIX_HOMESERVER: "https://matrix.example.org",
      MATRIX_ACCESS_TOKEN: "default-secret",
    } satisfies NodeJS.ProcessEnv;

    expect(resolveConfiguredMatrixAccountIds(cfg, env)).toEqual(["default"]);
    expect(resolveMatrixDefaultOrOnlyAccountId(cfg, env)).toBe("default");
  });
});
