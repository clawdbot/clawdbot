import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveTeamsMeetingsConfig } from "./config.js";

const realtimeMocks = vi.hoisted(() => ({
  speak: vi.fn(),
  startAgent: vi.fn(async () => ({
    getHealth: () => ({}),
    providerId: "test",
    speak: realtimeMocks.speak,
    stop: vi.fn(async () => {}),
  })),
}));

vi.mock("openclaw/plugin-sdk/meeting-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("openclaw/plugin-sdk/meeting-runtime")>();
  return {
    ...original,
    createNodeMeetingRealtimeAudioTransport: () => ({
      clearOutput: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
      onFatal: vi.fn(),
      startInput: vi.fn(),
      stop: vi.fn(async () => {}),
      writeOutput: vi.fn(async () => {}),
    }),
    startMeetingAgentRealtimeEngine: realtimeMocks.startAgent,
  };
});

import { TeamsMeetingsRuntime } from "./runtime.js";

const URL = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_node_resume%40thread.v2/0";

describe("Microsoft Teams meetings node realtime recovery", () => {
  it("starts the node bridge after manual admission becomes route-ready", async () => {
    let routeReady = false;
    let tabOpen = false;
    const invoke = vi.fn(async (request: Record<string, unknown>) => {
      const params = (request.params as Record<string, unknown>) ?? {};
      if (request.command === "browser.proxy") {
        if (params.path === "/tabs") {
          return {
            payload: {
              result: {
                tabs: tabOpen ? [{ targetId: "teams-tab", title: "Teams", url: URL }] : [],
              },
            },
          };
        }
        if (params.path === "/tabs/open") {
          tabOpen = true;
          return { payload: { result: { targetId: "teams-tab", title: "Teams", url: URL } } };
        }
        if (params.path === "/tabs/focus") {
          return { payload: { result: { ok: true } } };
        }
        if (params.path === "/act") {
          const scriptValue = (params.body as { fn?: unknown } | undefined)?.fn;
          const script = typeof scriptValue === "string" ? scriptValue : "";
          if (script.includes("leaveAction")) {
            return {
              payload: {
                result: { result: JSON.stringify({ departed: true, urlMatched: true }) },
              },
            };
          }
          return {
            payload: {
              result: {
                result: JSON.stringify(
                  routeReady
                    ? {
                        audioInputRouted: true,
                        audioOutputRouted: true,
                        inCall: true,
                        micMuted: false,
                        url: URL,
                      }
                    : {
                        inCall: false,
                        manualActionMessage: "Waiting for admission",
                        manualActionReason: "teams-admission-required",
                        manualActionRequired: true,
                        url: URL,
                      },
                ),
              },
            },
          };
        }
      }
      if (params.action === "start") {
        return {
          payload: {
            audioBridge: { type: "node-command-pair" },
            bridgeId: "bridge-1",
          },
        };
      }
      return { payload: { ok: true } };
    });
    const runtime = new TeamsMeetingsRuntime({
      config: resolveTeamsMeetingsConfig({
        chrome: { waitForInCallMs: 1 },
        chromeNode: { node: "node-1" },
      }),
      fullConfig: {},
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      runtime: {
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
      } as unknown as PluginRuntime,
    });

    const joined = await runtime.join({
      message: undefined,
      mode: "agent",
      requesterSessionKey: "agent:support:session:caller",
      transport: "chrome-node",
      url: URL,
    });
    expect(joined.session.chrome?.audioBridge).toBeUndefined();
    routeReady = true;

    const spoken = await runtime.speak(joined.session.id, "hello");

    expect(spoken.spoken).toBe(true);
    expect(realtimeMocks.startAgent).toHaveBeenCalledTimes(1);
    expect(realtimeMocks.startAgent).toHaveBeenCalledWith(
      expect.objectContaining({ requesterSessionKey: "agent:support:session:caller" }),
    );
    expect(realtimeMocks.speak).toHaveBeenCalledWith("hello");
    expect(joined.session.chrome?.audioBridge).toMatchObject({ type: "node-command-pair" });
  });
});
