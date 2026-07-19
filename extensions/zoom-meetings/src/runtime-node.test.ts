import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveZoomMeetingsConfig } from "./config.js";

const realtimeMocks = vi.hoisted(() => ({
  healths: [] as Array<{ bridgeClosed: boolean }>,
  speak: vi.fn(),
  startAgent: vi.fn(async () => {
    const health = { bridgeClosed: false };
    realtimeMocks.healths.push(health);
    return {
      getHealth: () => health,
      providerId: "test",
      speak: realtimeMocks.speak,
      stop: vi.fn(async () => {}),
    };
  }),
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

import { ZoomMeetingsRuntime } from "./runtime.js";

const URL = "https://zoom.us/j/12345678903?pwd=node";

describe("Zoom meetings node realtime recovery", () => {
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
                tabs: tabOpen ? [{ targetId: "zoom-tab", title: "Zoom", url: URL }] : [],
              },
            },
          };
        }
        if (params.path === "/tabs/open") {
          tabOpen = true;
          return { payload: { result: { targetId: "zoom-tab", title: "Zoom", url: URL } } };
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
                        manualActionReason: "zoom-admission-required",
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
    const runtime = new ZoomMeetingsRuntime({
      config: resolveZoomMeetingsConfig({
        chrome: { waitForInCallMs: 1 },
        chromeNode: { node: "node-1" },
        realtime: { agentId: "consult" },
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
                commands: ["browser.proxy", "zoommeetings.chrome"],
                connected: true,
                nodeId: "node-1",
              },
            ],
          })),
        },
      } as unknown as PluginRuntime,
    });

    const joined = await runtime.join({
      agentId: "support",
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
    expect(joined.session.agentId).toBe("support");
    expect(realtimeMocks.startAgent).toHaveBeenCalledTimes(1);
    expect(realtimeMocks.startAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          realtime: expect.objectContaining({ agentId: "consult" }),
        }),
        requesterSessionKey: "agent:support:session:caller",
      }),
    );
    expect(realtimeMocks.speak).toHaveBeenCalledWith("hello");
    expect(joined.session.chrome?.audioBridge).toMatchObject({ type: "node-command-pair" });

    realtimeMocks.healths[0]!.bridgeClosed = true;
    await runtime.status(joined.session.id);
    const recovered = await runtime.speak(joined.session.id, "again");

    expect(recovered.spoken).toBe(true);
    expect(realtimeMocks.startAgent).toHaveBeenCalledTimes(2);
    expect(realtimeMocks.speak).toHaveBeenCalledWith("again");
    expect(joined.session.chrome?.health?.bridgeClosed).toBe(false);
  });
});
