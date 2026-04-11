import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig } from "../runtime-api.js";

const hostMockState = vi.hoisted(() => ({
  tokenError: null as Error | null,
}));

vi.mock("@microsoft/teams.apps", () => ({
  App: class {
    protected async getBotToken() {
      if (hostMockState.tokenError) {
        throw hostMockState.tokenError;
      }
      return { value: "token" };
    }
    protected async getAppGraphToken() {
      if (hostMockState.tokenError) {
        throw hostMockState.tokenError;
      }
      return { value: "token" };
    }
  },
}));

vi.mock("@microsoft/teams.api", () => ({
  Client: function Client() {},
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
    await expect(probeMSTeams(cfg)).resolves.toMatchObject({
      ok: false,
    });
  });

  it("validates credentials by acquiring a token", async () => {
    const cfg = {
      enabled: true,
      appId: "app",
      appPassword: "pw",
      tenantId: "tenant",
    } as unknown as MSTeamsConfig;
    await expect(probeMSTeams(cfg)).resolves.toMatchObject({
      ok: true,
      appId: "app",
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
    await expect(probeMSTeams(cfg)).resolves.toMatchObject({
      ok: false,
      appId: "app",
      error: "bad creds",
    });
  });
});
