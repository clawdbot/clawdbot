// Msteams tests cover probe token request deadlines.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig } from "../runtime-api.js";

const sdkState = vi.hoisted(() => ({
  stall: null as "bot" | "graph" | null,
}));

vi.mock("@microsoft/teams.apps", () => ({
  App: class {
    tokenManager = {
      async getBotToken() {
        if (sdkState.stall === "bot") {
          return await new Promise<never>(() => {});
        }
        return { toString: () => "test-token" };
      },
      async getGraphToken() {
        if (sdkState.stall === "graph") {
          return await new Promise<never>(() => {});
        }
        return { toString: () => "test-token" };
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
import { MSTEAMS_REQUEST_TIMEOUT_MS } from "./request-timeout.js";

const cfg = {
  enabled: true,
  appId: "app-id",
  appPassword: "test-app-password",
  tenantId: "tenant-id",
} as unknown as MSTeamsConfig;

describe("probeMSTeams request deadline", () => {
  beforeEach(() => {
    sdkState.stall = null;
    vi.stubEnv("MSTEAMS_APP_ID", "");
    vi.stubEnv("MSTEAMS_APP_PASSWORD", "");
    vi.stubEnv("MSTEAMS_TENANT_ID", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it.each([
    {
      stalled: "bot" as const,
      expected: {
        ok: false,
        appId: "app-id",
        error: `MS Teams Bot Framework probe token timed out after ${MSTEAMS_REQUEST_TIMEOUT_MS}ms`,
      },
    },
    {
      stalled: "graph" as const,
      expected: {
        ok: true,
        appId: "app-id",
        graph: {
          ok: false,
          error: `MS Teams Graph probe token timed out after ${MSTEAMS_REQUEST_TIMEOUT_MS}ms`,
        },
      },
    },
  ])("bounds stalled $stalled token acquisition", async ({ stalled, expected }) => {
    sdkState.stall = stalled;
    vi.useFakeTimers();

    const result = expect(probeMSTeams(cfg)).resolves.toEqual(expected);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(MSTEAMS_REQUEST_TIMEOUT_MS);

    await result;
  });
});
