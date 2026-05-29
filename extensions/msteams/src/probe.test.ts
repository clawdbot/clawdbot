import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig } from "../runtime-api.js";

const hostMockState = vi.hoisted(() => ({
  tokenError: null as Error | null,
}));

vi.mock("@microsoft/teams.apps", () => ({
  App: class {
    tokenManager = {
      getBotToken: async () => {
        if (hostMockState.tokenError) {
          throw hostMockState.tokenError;
        }
        return { toString: () => "token" };
      },
      getGraphToken: async () => {
        if (hostMockState.tokenError) {
          throw hostMockState.tokenError;
        }
        return { toString: () => "token" };
      },
    };
  },
  ExpressAdapter: vi.fn(),
}));

vi.mock("@microsoft/teams.api", () => ({
  Client: function Client() {},
  cloudFromName: () => ({
    botScope: "https://api.botframework.com/.default",
    graphScope: "https://graph.microsoft.com/.default",
  }),
}));

import { probeMSTeams } from "./probe.js";

describe("msteams probe", () => {
  beforeEach(() => {
    hostMockState.tokenError = null;
    vi.stubEnv("MSTEAMS_APP_ID", "");
    vi.stubEnv("MSTEAMS_APP_PASSWORD", "");
    vi.stubEnv("MSTEAMS_TENANT_ID", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns an error when credentials are missing", async () => {
    const cfg = { enabled: true } as unknown as MSTeamsConfig;
    await expect(probeMSTeams(cfg)).resolves.toEqual({
      ok: false,
      error: "missing credentials (appId, appPassword, tenantId)",
    });
  });

  it("validates credentials by acquiring a token", async () => {
    const cfg = {
      enabled: true,
      appId: "app",
      appPassword: "pw",
      tenantId: "tenant",
    } as unknown as MSTeamsConfig;
    await expect(probeMSTeams(cfg)).resolves.toEqual({
      ok: true,
      appId: "app",
      graph: { ok: true, roles: undefined, scopes: undefined },
    });
  });

  it("returns a helpful error when token acquisition fails", async () => {
    hostMockState.tokenError = new Error("bad creds");
    const cfg = {
      enabled: true,
      appId: "app",
      appPassword: "pw",
      tenantId: "tenant",
    } as unknown as MSTeamsConfig;
    await expect(probeMSTeams(cfg)).resolves.toEqual({
      ok: false,
      appId: "app",
      error: "bad creds",
    });
  });
});
