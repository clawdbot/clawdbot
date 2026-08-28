import type { BrowserNodeDelegationRequest } from "openclaw/plugin-sdk/browser-node-delegation-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { attachBrowserNodeDelegationForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { teamsMeetingsConfig } from "../config.js";

const resolveTeamsMeetingsConfig = teamsMeetingsConfig.resolveConfig;

function bindBrowserDelegation(runtime: PluginRuntime): void {
  const browser = (
    runtime as unknown as {
      browser: { request: (params: BrowserNodeDelegationRequest) => Promise<unknown> };
    }
  ).browser;
  attachBrowserNodeDelegationForTest(runtime, browser);
}

const engineMocks = vi.hoisted(() => ({
  localDispose: vi.fn(async () => {}),
  nodeDispose: vi.fn(async () => {}),
  startAgent: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/meeting-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("openclaw/plugin-sdk/meeting-runtime")>();
  const transport = (dispose: () => Promise<void>) => ({
    clearOutput: vi.fn(async () => {}),
    dispose,
    onFatal: vi.fn(),
    startInput: vi.fn(),
    stop: dispose,
    writeOutput: vi.fn(async () => {}),
  });
  return {
    ...original,
    MeetingPlatformAdapter: {
      ...original.MeetingPlatformAdapter,
      createChromeRuntimeBindings: () => ({
        createBindings: original.createMeetingRealtimeEngineBindings,
        createLocalAudioTransport: () => transport(engineMocks.localDispose),
        createNodeAudioTransport: () => transport(engineMocks.nodeDispose),
        startAgentRealtimeEngine: engineMocks.startAgent,
        startRealtimeEngine: original.startMeetingRealtimeEngine,
      }),
    },
  };
});

import { launchTeamsMeetingInChrome, launchTeamsMeetingOnNode } from "./chrome.js";

const URL = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_rollback%40thread.v2/0";

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

function browserResult(params: Record<string, unknown>, state: { tabOpen: boolean }) {
  if (params.path === "/tabs") {
    return {
      tabs: state.tabOpen ? [{ targetId: "teams-tab", title: "Teams", url: URL }] : [],
    };
  }
  if (params.path === "/tabs/open") {
    state.tabOpen = true;
    return { targetId: "teams-tab", title: "Teams", url: URL };
  }
  if (params.path === "/tabs/focus") {
    return { ok: true };
  }
  if (params.path === "/act") {
    const scriptValue = (params.body as { fn?: unknown } | undefined)?.fn;
    const script = typeof scriptValue === "string" ? scriptValue : "";
    return script.includes("leaveAction")
      ? { result: JSON.stringify({ departed: true, urlMatched: true }) }
      : {
          result: JSON.stringify({
            audioInputRouted: true,
            audioOutputRouted: true,
            inCall: true,
            micMuted: false,
            url: URL,
          }),
        };
  }
  if (params.method === "DELETE" && params.path === "/tabs/teams-tab") {
    state.tabOpen = false;
    return { ok: true };
  }
  throw new Error(
    ["Unexpected browser request:", String(params.method), String(params.path)].join(" "),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  engineMocks.startAgent.mockRejectedValue(new Error("realtime startup failed"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Microsoft Teams meeting Chrome startup cleanup", () => {
  it("keeps auto-join enabled when recovering an active meeting tab", async () => {
    const state = { tabOpen: true };
    const gatewayRequest = vi.fn(async (_method: string, params: Record<string, unknown>) =>
      browserResult(params, state),
    );
    const runtime = {
      gateway: { isAvailable: vi.fn(async () => true), request: gatewayRequest },
      browser: {
        request: async (params: BrowserNodeDelegationRequest) =>
          await gatewayRequest("browser.request", params),
      },
      system: {
        runCommandWithTimeout: vi.fn(async () => ({
          code: 0,
          stderr: "",
          stdout: "BlackHole 2ch",
        })),
      },
    } as unknown as PluginRuntime;
    bindBrowserDelegation(runtime);

    await expect(
      launchTeamsMeetingInChrome({
        config: resolveTeamsMeetingsConfig({
          chrome: { launch: false, waitForInCallMs: 1 },
        }),
        fullConfig: {},
        logger,
        meetingSessionId: "session-1",
        mode: "agent",
        runtime,
        trackedTargetId: "teams-tab",
        url: URL,
      }),
    ).rejects.toThrow("realtime startup failed");

    const evaluated = gatewayRequest.mock.calls.find(
      ([, params]) =>
        params.path === "/act" &&
        !(params.body as { fn?: string } | undefined)?.fn?.includes("leaveAction"),
    );
    expect((evaluated?.[1].body as { fn?: string } | undefined)?.fn).toContain(
      "const autoJoin = true",
    );
  });

  it("disposes local audio and leaves the browser when realtime startup fails", async () => {
    const state = { tabOpen: false };
    const gatewayRequest = vi.fn(async (_method: string, params: Record<string, unknown>) =>
      browserResult(params, state),
    );
    const runtime = {
      gateway: { isAvailable: vi.fn(async () => true), request: gatewayRequest },
      browser: {
        request: async (params: BrowserNodeDelegationRequest) =>
          await gatewayRequest("browser.request", params),
      },
      system: {
        runCommandWithTimeout: vi.fn(async () => ({
          code: 0,
          stderr: "",
          stdout: "BlackHole 2ch",
        })),
      },
    } as unknown as PluginRuntime;
    bindBrowserDelegation(runtime);

    await expect(
      launchTeamsMeetingInChrome({
        config: resolveTeamsMeetingsConfig({ chrome: { waitForInCallMs: 1 } }),
        fullConfig: {},
        logger,
        meetingSessionId: "session-1",
        mode: "agent",
        runtime,
        url: URL,
      }),
    ).rejects.toThrow("realtime startup failed");

    expect(engineMocks.localDispose).toHaveBeenCalled();
    expect(gatewayRequest).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({ method: "DELETE", path: "/tabs/teams-tab" }),
    );
    expect(state.tabOpen).toBe(false);
  });

  it("stops node audio and leaves the remote browser when realtime startup fails", async () => {
    const state = { tabOpen: false };
    const invoke = vi.fn(async (request: Record<string, unknown>) => {
      if (request.command === "browser.proxy") {
        return {
          payload: {
            result: browserResult((request.params as Record<string, unknown>) ?? {}, state),
          },
        };
      }
      const params = (request.params as Record<string, unknown>) ?? {};
      if (params.action === "start") {
        return { payload: { audioBridge: { type: "node-command-pair" }, bridgeId: "bridge-1" } };
      }
      return { payload: { ok: true } };
    });
    const runtime = {
      nodes: {
        invoke,
        list: vi.fn(async () => ({
          nodes: [
            {
              caps: ["browser"],
              commands: ["browser.proxy", "teamsmeetings.chrome"],
              connected: true,
              nodeId: "node-1",
            },
          ],
        })),
      },
      browser: {
        request: async (params: BrowserNodeDelegationRequest) => {
          const response = await invoke({ command: "browser.proxy", params });
          return (response.payload as { result?: unknown }).result;
        },
      },
    } as unknown as PluginRuntime;
    bindBrowserDelegation(runtime);

    await expect(
      launchTeamsMeetingOnNode({
        config: resolveTeamsMeetingsConfig({ chrome: { waitForInCallMs: 1 } }),
        fullConfig: {},
        logger,
        meetingSessionId: "session-1",
        mode: "agent",
        runtime,
        url: URL,
      }),
    ).rejects.toThrow("realtime startup failed");

    expect(engineMocks.nodeDispose).toHaveBeenCalled();
    expect(
      invoke.mock.calls.filter(
        ([request]) =>
          request.command === "teamsmeetings.chrome" &&
          (request.params as Record<string, unknown>)?.action === "stopByUrl",
      ),
    ).toHaveLength(2);
    expect(
      invoke.mock.calls.some(
        ([request]) =>
          request.command === "browser.proxy" &&
          (request.params as Record<string, unknown>)?.method === "DELETE",
      ),
    ).toBe(true);
    expect(state.tabOpen).toBe(false);
  });
});
