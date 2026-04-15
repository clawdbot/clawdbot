import { describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

vi.mock("../chrome-mcp.js", () => ({
  getChromeMcpPid: vi.fn(() => 4321),
}));

const { BrowserProfileUnavailableError } = await import("../errors.js");
const { registerBrowserBasicRoutes } = await import("./basic.js");

function createExistingSessionProfileState(params?: { isHttpReachable?: () => Promise<boolean> }) {
  return {
    resolved: {
      enabled: true,
      headless: false,
      noSandbox: false,
      executablePath: undefined,
    },
    profiles: new Map(),
    forProfile: () =>
      ({
        profile: {
          name: "chrome-live",
          driver: "existing-session",
          cdpPort: 0,
          cdpUrl: "",
          userDataDir: "/tmp/brave-profile",
          color: "#00AA00",
          attachOnly: true,
        },
        isHttpReachable: params?.isHttpReachable ?? (async () => true),
        isReachable: async () => true,
      }) as never,
  };
}

async function callBasicRouteWithState(params: {
  query?: Record<string, string>;
  state: ReturnType<typeof createExistingSessionProfileState>;
}) {
  const { app, getHandlers } = createBrowserRouteApp();
  registerBrowserBasicRoutes(app, {
    state: () => params.state,
    forProfile: params.state.forProfile,
  } as never);

  const handler = getHandlers.get("/");
  expect(handler).toBeTypeOf("function");

  const response = createBrowserRouteResponse();
  await handler?.({ params: {}, query: params.query ?? { profile: "chrome-live" } }, response.res);
  return response;
}

describe("basic browser routes", () => {
  it("maps existing-session status failures to JSON browser errors", async () => {
    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState({
        isHttpReachable: async () => {
          throw new BrowserProfileUnavailableError("attach failed");
        },
      }),
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ error: "attach failed" });
  });

  it("reports Chrome MCP transport without fake CDP fields", async () => {
    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      profile: "chrome-live",
      driver: "existing-session",
      transport: "chrome-mcp",
      running: true,
      cdpPort: null,
      cdpUrl: null,
      userDataDir: "/tmp/brave-profile",
      pid: 4321,
    });
  });
});
