import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTicket: vi.fn(),
  getView: vi.fn(),
  peekRuntime: vi.fn(),
}));

vi.mock("../agents/agent-bundle-mcp-runtime.js", () => ({
  peekSessionMcpRuntime: mocks.peekRuntime,
}));
vi.mock("../agents/mcp-ui-resource.js", () => ({
  getMcpAppViewLease: mocks.getView,
}));
vi.mock("./mcp-app-standalone.js", () => ({
  createMcpAppStandaloneTicket: mocks.createTicket,
}));

import { materializeMcpAppChannelPresentation } from "./mcp-app-channel-action.js";
import { getMcpAppChannelOrigin, prepareMcpAppChannelOrigin } from "./mcp-app-channel-origin.js";

const nowMs = 1_800_000_000_000;
const runtime = { sessionId: "runtime-session", mcpAppsEnabled: true };
const view = {
  viewId: "view-latest",
  sessionId: runtime.sessionId,
  expiresAtMs: nowMs + 60_000,
  html: "do-not-emit-html",
  toolInput: { privateInput: "do-not-emit-input" },
  toolResult: { privateResult: "do-not-emit-result" },
};

function resetMcpAppChannelOrigin() {
  prepareMcpAppChannelOrigin({ origin: "https://reset.test", reachability: "tailnet" })();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMcpAppChannelOrigin();
  mocks.peekRuntime.mockReturnValue(runtime);
  mocks.getView.mockReturnValue(view);
  mocks.createTicket.mockReturnValue({
    ticket: "opaque-ticket",
    url: "/__openclaw__/mcp-app#opaque-ticket",
    expiresAtMs: nowMs + 60_000,
  });
});

describe("MCP App channel origin", () => {
  it("stores one lifecycle-owned Serve or Funnel snapshot", () => {
    const clearServe = prepareMcpAppChannelOrigin({
      origin: "https://node.tailnet.ts.net",
      reachability: "tailnet",
    });
    const clearFunnel = prepareMcpAppChannelOrigin({
      origin: "https://public.example.ts.net/",
      reachability: "internet",
    });

    expect(getMcpAppChannelOrigin()).toEqual({
      origin: "https://public.example.ts.net",
      reachability: "internet",
    });
    clearServe();
    expect(getMcpAppChannelOrigin()).toBeDefined();
    clearFunnel();
    expect(getMcpAppChannelOrigin()).toBeUndefined();
  });

  it.each(["http://node.test", "https://%75@node.test", "https://node.test/path"])(
    "rejects unsafe origin %s",
    (origin) => {
      expect(() => prepareMcpAppChannelOrigin({ origin, reachability: "tailnet" })).toThrow(
        "absolute HTTPS origin",
      );
    },
  );
});

describe("materializeMcpAppChannelPresentation", () => {
  it("mints late and emits only one typed action with an opaque ticket", () => {
    prepareMcpAppChannelOrigin({
      origin: "https://node.tailnet.ts.net",
      reachability: "tailnet",
    });

    const presentation = materializeMcpAppChannelPresentation({
      sessionKey: "agent:main:do-not-emit-session",
      view: { viewId: "view-latest", title: "do-not-emit-title" } as never,
      nowMs,
    });

    expect(mocks.createTicket).toHaveBeenCalledOnce();
    expect(presentation).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Open app",
              action: {
                type: "web-app",
                url: "https://node.tailnet.ts.net/__openclaw__/mcp-app#opaque-ticket",
              },
            },
          ],
        },
      ],
    });
    const serialized = JSON.stringify(presentation);
    for (const privateValue of [
      view.html,
      "do-not-emit-input",
      "do-not-emit-result",
      "do-not-emit-session",
      "do-not-emit-title",
      view.viewId,
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it.each([
    ["missing origin", resetMcpAppChannelOrigin],
    ["missing view", () => mocks.getView.mockReturnValue(undefined)],
    ["expired view", () => mocks.getView.mockReturnValue({ ...view, expiresAtMs: nowMs })],
    ["ticket capacity", () => mocks.createTicket.mockReturnValue(undefined)],
  ])("omits the action for %s", (_name, arrange) => {
    prepareMcpAppChannelOrigin({
      origin: "https://node.tailnet.ts.net",
      reachability: "tailnet",
    });
    arrange();

    expect(
      materializeMcpAppChannelPresentation({
        sessionKey: "agent:main:main",
        view: { viewId: "view-latest" },
        nowMs,
      }),
    ).toBeUndefined();
  });
});
