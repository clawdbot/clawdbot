import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDiscordToken } from "./token.js";

describe("resolveDiscordToken", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
  });

  it("prefers config token over env", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-token");
    const cfg = {
      channels: { discord: { token: "cfg-token" } },
    } as OpenClawConfig;
    const res = resolveDiscordToken(cfg);
    expect(res.token).toBe("cfg-token");
    expect(res.source).toBe("config");
    expect(res.tokenStatus).toBe("available");
  });

  it("uses env token when config is missing", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-token");
    const cfg = {
      channels: { discord: {} },
    } as OpenClawConfig;
    const res = resolveDiscordToken(cfg);
    expect(res.token).toBe("env-token");
    expect(res.source).toBe("env");
    expect(res.tokenStatus).toBe("available");
  });

  it("prefers account token for non-default accounts", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-token");
    const cfg = {
      channels: {
        discord: {
          token: "base-token",
          accounts: {
            work: { token: "acct-token" },
          },
        },
      },
    } as OpenClawConfig;
    const res = resolveDiscordToken(cfg, { accountId: "work" });
    expect(res.token).toBe("acct-token");
    expect(res.source).toBe("config");
    expect(res.tokenStatus).toBe("available");
  });

  it("falls back to top-level token for non-default accounts without account token", () => {
    const cfg = {
      channels: {
        discord: {
          token: "base-token",
          accounts: {
            work: {},
          },
        },
      },
    } as OpenClawConfig;
    const res = resolveDiscordToken(cfg, { accountId: "work" });
    expect(res.token).toBe("base-token");
    expect(res.source).toBe("config");
    expect(res.tokenStatus).toBe("available");
  });

  it("does not inherit top-level token when account token is explicitly blank", () => {
    const cfg = {
      channels: {
        discord: {
          token: "base-token",
          accounts: {
            work: { token: "" },
          },
        },
      },
    } as OpenClawConfig;
    const res = resolveDiscordToken(cfg, { accountId: "work" });
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
    expect(res.tokenStatus).toBe("missing");
  });

  it("resolves account token when account key casing differs from normalized id", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            Work: { token: "acct-token" },
          },
        },
      },
    } as OpenClawConfig;
    const res = resolveDiscordToken(cfg, { accountId: "work" });
    expect(res.token).toBe("acct-token");
    expect(res.source).toBe("config");
    expect(res.tokenStatus).toBe("available");
  });

  it("uses the active runtime snapshot when resolving a matching source config", () => {
    const sourceCfg = {
      channels: {
        discord: {
          accounts: {
            work: {
              token: { source: "env", provider: "default", id: "DISCORD_WORK_TOKEN" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const runtimeCfg = {
      channels: {
        discord: {
          accounts: {
            work: {
              token: "Bot runtime-work-token",
            },
          },
        },
      },
    } as OpenClawConfig;
    setRuntimeConfigSnapshot(runtimeCfg, sourceCfg);

    const res = resolveDiscordToken(sourceCfg, { accountId: "work" });

    expect(res.token).toBe("runtime-work-token");
    expect(res.source).toBe("config");
    expect(res.tokenStatus).toBe("available");
  });

  it("treats unresolved top-level SecretRefs as configured unavailable without env fallback", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-token");
    const cfg = {
      channels: {
        discord: {
          token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
        },
      },
    } as unknown as OpenClawConfig;

    const res = resolveDiscordToken(cfg);

    expect(res.token).toBe("");
    expect(res.source).toBe("config");
    expect(res.tokenStatus).toBe("configured_unavailable");
  });

  it("treats unresolved account SecretRefs as configured unavailable without top-level fallback", () => {
    const cfg = {
      channels: {
        discord: {
          token: "base-token",
          accounts: {
            work: {
              token: { source: "env", provider: "default", id: "DISCORD_WORK_TOKEN" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const res = resolveDiscordToken(cfg, { accountId: "work" });

    expect(res.token).toBe("");
    expect(res.source).toBe("config");
    expect(res.tokenStatus).toBe("configured_unavailable");
  });
});
