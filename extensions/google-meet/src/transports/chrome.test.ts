// Google Meet tests cover chrome plugin behavior.
import { runInNewContext } from "node:vm";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveGoogleMeetConfig } from "../config.js";
import { GoogleMeetRuntime } from "../runtime.js";
import { MEET_URL, MEET_URL_EN } from "../test-support/fixtures.test-helpers.js";
import {
  launchChromeMeet,
  leaveChromeMeet,
  readChromeMeetTranscript,
  recoverCurrentMeetTab,
} from "./chrome.js";

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

type TestGatewayRequest = (
  method: string,
  params: Record<string, unknown>,
  options?: unknown,
) => Promise<unknown>;

function browserRuntime(
  request: TestGatewayRequest,
  nodes?: Pick<PluginRuntime["nodes"], "list" | "invoke">,
): PluginRuntime {
  const gateway: PluginRuntime["gateway"] = {
    isAvailable: async () => true,
    request: async <T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      options?: unknown,
    ) => (await request(method, params ?? {}, options)) as T,
  };
  return { gateway, ...(nodes ? { nodes } : {}) } as PluginRuntime;
}

describe("google meet chrome transport", () => {
  it.each([
    { mode: "agent" as const, fullConfig: { transcripts: { enabled: false } }, capture: false },
    { mode: "bidi" as const, fullConfig: undefined, capture: true },
    { mode: "transcribe" as const, fullConfig: { transcripts: { enabled: false } }, capture: true },
  ])(
    "prefers a meeting tab over login ($mode, captions $capture)",
    async ({ mode, fullConfig, capture }) => {
      const statusScripts: string[] = [];
      const gatewayRequest = vi.fn(async (_method, params) => {
        if (params.path === "/tabs") {
          return {
            tabs: [
              {
                targetId: "google-login-tab",
                title: "Sign in - Google Accounts",
                url: "https://accounts.google.com/signin",
              },
              {
                targetId: "meet-tab",
                title: "Meet",
                url: "https://meet.google.com/abc-defg-hij?hl=en",
              },
            ],
          };
        }
        if (params.path === "/tabs/focus") {
          return { ok: true };
        }
        if (params.path === "/act") {
          const fn = (params.body as { fn?: unknown } | undefined)?.fn;
          if (typeof fn === "string") {
            statusScripts.push(fn);
          }
          return {
            result: JSON.stringify({
              inCall: true,
              micMuted: true,
              url: "https://meet.google.com/abc-defg-hij?hl=en",
            }),
          };
        }
        throw new Error(`unexpected browser request path ${String(params.path)}`);
      });

      const recovered = await recoverCurrentMeetTab({
        runtime: browserRuntime(gatewayRequest),
        config: resolveGoogleMeetConfig({}),
        fullConfig,
        mode,
        readOnly: true,
      });

      expect(recovered).toMatchObject({ transport: "chrome", found: true, targetId: "meet-tab" });
      expect(Object.hasOwn(recovered, "nodeId")).toBe(false);
      expect(statusScripts).toHaveLength(1);
      expect(statusScripts[0]).toContain(`const captureCaptions = ${capture}`);
    },
  );

  it("prefers the tracked target for an unchanged Google Meet URL", async () => {
    const gatewayRequest = vi.fn(async (_method, params) => {
      if (params.path === "/tabs") {
        return {
          tabs: [
            {
              targetId: "other-meet-tab",
              title: "Meet",
              url: "https://meet.google.com/abc-defg-hij?hl=en",
            },
            {
              targetId: "tracked-meet-tab",
              title: "Meet",
              url: "https://meet.google.com/abc-defg-hij?hl=en",
            },
          ],
        };
      }
      if (params.path === "/tabs/focus") {
        return { ok: true };
      }
      if (params.path === "/act") {
        return {
          result: JSON.stringify({
            inCall: true,
            micMuted: true,
            url: "https://meet.google.com/abc-defg-hij?hl=en",
          }),
        };
      }
      throw new Error(`unexpected browser request path ${String(params.path)}`);
    });

    const recovered = await recoverCurrentMeetTab({
      runtime: browserRuntime(gatewayRequest),
      config: resolveGoogleMeetConfig({}),
      mode: "transcribe",
      readOnly: true,
      trackedMeetingUrl: "https://meet.google.com/abc-defg-hij?authuser=0",
      trackedTargetId: "tracked-meet-tab",
      url: "https://meet.google.com/abc-defg-hij?hl=en",
    });

    expect(recovered).toMatchObject({ found: true, targetId: "tracked-meet-tab" });
    expect(gatewayRequest).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        path: "/act",
        body: expect.objectContaining({ targetId: "tracked-meet-tab" }),
      }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
  });

  it("falls back from a tracked target that identifies another meeting", async () => {
    const gatewayRequest = vi.fn(async (_method, params) => {
      if (params.path === "/tabs") {
        return {
          tabs: [
            {
              targetId: "matching-meet-tab",
              title: "Meet",
              url: "https://meet.google.com/abc-defg-hij?hl=en",
            },
            {
              targetId: "tracked-meet-tab",
              title: "Meet",
              url: "https://meet.google.com/xyz-abcd-efg?hl=en",
            },
          ],
        };
      }
      if (params.path === "/tabs/focus") {
        return { ok: true };
      }
      if (params.path === "/act") {
        return {
          result: JSON.stringify({
            inCall: true,
            micMuted: true,
            url: "https://meet.google.com/abc-defg-hij?hl=en",
          }),
        };
      }
      throw new Error(`unexpected browser request path ${String(params.path)}`);
    });

    const recovered = await recoverCurrentMeetTab({
      runtime: browserRuntime(gatewayRequest),
      config: resolveGoogleMeetConfig({}),
      mode: "transcribe",
      readOnly: true,
      trackedMeetingUrl: "https://meet.google.com/abc-defg-hij?authuser=0",
      trackedTargetId: "tracked-meet-tab",
      url: "https://meet.google.com/abc-defg-hij?hl=en",
    });

    expect(recovered).toMatchObject({ found: true, targetId: "matching-meet-tab" });
  });

  it("wraps malformed browser status JSON through tab recovery", async () => {
    const runtime = browserRuntime(
      vi.fn(async (_method, params) => {
        if (params.path === "/tabs") {
          return {
            tabs: [
              {
                targetId: "meet-tab",
                title: "Meet",
                url: "https://meet.google.com/abc-defg-hij?hl=en",
              },
            ],
          };
        }
        if (params.path === "/tabs/focus") {
          return { ok: true };
        }
        if (params.path === "/act") {
          return { result: "{not json" };
        }
        throw new Error(`unexpected browser request path ${String(params.path)}`);
      }),
    );

    await expect(
      recoverCurrentMeetTab({
        runtime,
        config: resolveGoogleMeetConfig({}),
        mode: "transcribe",
        readOnly: true,
      }),
    ).rejects.toThrow("Google Meet browser status JSON is malformed.");
  });

  it.each([
    [10_000, 15_000],
    [Number.MAX_SAFE_INTEGER, MAX_TIMER_TIMEOUT_MS],
  ])("caps browser gateway timeout padding for %s ms", async (joinTimeoutMs, expectedTimeoutMs) => {
    const gatewayRequest = vi.fn(async (_method, params) => {
      if (params.path === "/tabs/open") {
        return {
          targetId: "meet-tab",
          title: "Meet",
          url: "https://meet.google.com/abc-defg-hij?hl=en",
        };
      }
      if (params.path === "/act") {
        return {
          result: JSON.stringify({
            manualAction: {
              reason: "meet-admission-required",
              message: "Waiting for admission",
            },
          }),
        };
      }
      throw new Error(`unexpected browser request path ${String(params.path)}`);
    });
    const baseConfig = resolveGoogleMeetConfig({});

    await launchChromeMeet({
      runtime: browserRuntime(gatewayRequest),
      config: {
        ...baseConfig,
        chrome: {
          ...baseConfig.chrome,
          joinTimeoutMs,
          reuseExistingTab: false,
        },
      },
      fullConfig: {},
      meetingSessionId: "session-1",
      mode: "transcribe",
      url: "https://meet.google.com/abc-defg-hij",
      logger,
    });

    expect(gatewayRequest).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({ path: "/tabs/open", timeoutMs: joinTimeoutMs }),
      { timeoutMs: expectedTimeoutMs, scopes: ["operator.admin"] },
    );
  });

  it("keeps Gateway-hosted local browser calls inside the trusted runtime", async () => {
    const gatewayRequest = vi.fn(async () => ({ tabs: [] }));
    const runtime = browserRuntime(gatewayRequest);

    await recoverCurrentMeetTab({
      runtime,
      config: resolveGoogleMeetConfig({}),
    });

    expect(gatewayRequest).toHaveBeenCalledWith(
      "browser.request",
      {
        method: "GET",
        path: "/tabs",
        body: undefined,
        timeoutMs: 5_000,
      },
      { timeoutMs: 10_000, scopes: ["operator.admin"] },
    );
  });
  it.each(["pinned-node", ""])(
    "leaves through a pinned node %j before yielding to inventory",
    async (nodeId) => {
      const requests: Parameters<PluginRuntime["nodes"]["invoke"]>[0][] = [];
      const runtime = browserRuntime(
        async () => {
          throw new Error("Pinned node leave must not use the local browser");
        },
        {
          list: async () => {
            throw new Error("Pinned node leave must not resolve inventory");
          },
          invoke: async (request) => {
            requests.push(request);
            return { payload: { result: { tabs: [] } } };
          },
        },
      );
      const leaving = leaveChromeMeet({
        transport: "chrome-node",
        runtime,
        config: resolveGoogleMeetConfig({ chromeNode: { node: "different-configured-node" } }),
        nodeId,
        meetingSessionId: "pinned-session",
        meetingUrl: MEET_URL,
        tab: { targetId: "pinned-tab", openedByPlugin: false },
      });
      const beforeYield = [...requests];
      const result = await leaving;

      expect(result).toStrictEqual({ left: true, note: "Meet tab is already closed." });
      expect(beforeYield).toStrictEqual([
        {
          nodeId,
          command: "browser.proxy",
          params: { method: "GET", path: "/tabs", body: undefined, timeoutMs: 5_000 },
          timeoutMs: 10_000,
          scopes: ["operator.admin"],
        },
      ]);
    },
  );

  it.each(["chrome", "chrome-node"] as const)(
    "preserves %s route failures before launch-disabled leave",
    async (transport) => {
      const failure = new Error("route unavailable");
      const events: string[] = [];
      const runtime = browserRuntime(
        async () => {
          throw new Error("Disabled leave must not dispatch a local browser request");
        },
        {
          list: async () => {
            events.push("inventory");
            throw failure;
          },
          invoke: async () => {
            throw new Error("Disabled leave must not invoke a node");
          },
        },
      );
      runtime.gateway.isAvailable = async () => {
        events.push("availability");
        throw failure;
      };
      const leaving = leaveChromeMeet({
        ...(transport === "chrome-node" ? { transport } : {}),
        runtime,
        config: resolveGoogleMeetConfig({ chrome: { launch: false } }),
        meetingSessionId: "disabled-session",
        meetingUrl: MEET_URL,
        tab: { targetId: "disabled-tab", openedByPlugin: false },
      });

      if (transport === "chrome-node") {
        await expect(leaving).rejects.toMatchObject({
          message: "Google Meet node inventory unavailable",
          cause: failure,
        });
        expect(events).toStrictEqual(["inventory"]);
      } else {
        await expect(leaving).rejects.toBe(failure);
        expect(events).toStrictEqual(["availability"]);
      }
    },
  );

  it("re-resolves configured recovery nodes and preserves node response identity", async () => {
    const invocations: Parameters<PluginRuntime["nodes"]["invoke"]>[0][] = [];
    const config = resolveGoogleMeetConfig({ chromeNode: { node: "first-host" } });
    const runtime = browserRuntime(
      async () => {
        throw new Error("Node recovery must not fall back to the local browser");
      },
      {
        list: async () => ({
          nodes: ["first", "second"].map((id) => ({
            nodeId: `${id}-node`,
            displayName: `${id}-host`,
            connected: true,
            commands: ["googlemeet.chrome", "browser.proxy"],
          })),
        }),
        invoke: async (request) => {
          invocations.push(request);
          return { payload: { result: { tabs: [] } } };
        },
      },
    );
    const meet = new GoogleMeetRuntime({ runtime, config, fullConfig: {}, logger });
    const first = await meet.recoverCurrentTab({ transport: "chrome-node" });
    config.chromeNode.node = "second-host";
    const second = await meet.recoverCurrentTab({ transport: "chrome-node" });

    for (const [result, nodeId] of [
      [first, "first-node"],
      [second, "second-node"],
    ] as const) {
      expect(Object.hasOwn(result, "nodeId")).toBe(true);
      expect(result).toStrictEqual({
        transport: "chrome-node",
        nodeId,
        found: false,
        tab: undefined,
        message: "No existing Meet tab found on the selected Chrome node.",
      });
    }
    expect(invocations).toStrictEqual(
      ["first-node", "second-node"].map((nodeId) => ({
        nodeId,
        command: "browser.proxy",
        params: { method: "GET", path: "/tabs", body: undefined, timeoutMs: 5_000 },
        timeoutMs: 10_000,
        scopes: ["operator.admin"],
      })),
    );
  });

  it.each([
    { transport: "chrome" as const, finalize: undefined, joinTimeoutMs: 1_234, timeoutMs: 1_234 },
    { transport: "chrome-node" as const, finalize: false, joinTimeoutMs: 1, timeoutMs: 1_000 },
    { transport: "chrome-node" as const, finalize: true, joinTimeoutMs: 30_000, timeoutMs: 10_000 },
  ])(
    "reads $transport captions with finalize=$finalize and bounded envelope",
    async ({ transport, finalize, joinTimeoutMs, timeoutMs }) => {
      const committed = {
        at: "2026-09-01T00:00:00.000Z",
        speaker: "First",
        text: "Completed caption",
      };
      const visible = {
        at: "2026-09-01T00:00:01.000Z",
        speaker: "Second",
        text: "Progressive caption",
      };
      const captionState = {
        sessionId: "transcript-session",
        epoch: "caption-epoch",
        droppedLines: 0,
        lines: [committed],
        visible: [visible],
        settleTimer: undefined,
      };
      const browserCalls: Array<{
        method: string;
        params: Record<string, unknown>;
        options: unknown;
      }> = [];
      const nodeCalls: Parameters<PluginRuntime["nodes"]["invoke"]>[0][] = [];
      const evaluate = (params: Record<string, unknown>) => {
        const body = params.body as { fn: string };
        return {
          result: runInNewContext(`(${body.fn})()`, {
            JSON,
            URL,
            location: { href: MEET_URL_EN },
            window: { __openclawMeetCaptions: captionState },
            clearTimeout,
          }),
        };
      };
      const runtime = browserRuntime(
        async (method, params, options) => {
          browserCalls.push({ method, params, options });
          return evaluate(params);
        },
        {
          list: async () => {
            throw new Error("Pinned transcript read must not resolve inventory");
          },
          invoke: async (request) => {
            nodeCalls.push(request);
            return { payload: { result: evaluate(request.params as Record<string, unknown>) } };
          },
        },
      );
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      try {
        const result = await readChromeMeetTranscript({
          runtime,
          config: resolveGoogleMeetConfig({ chrome: { joinTimeoutMs } }),
          ...(transport === "chrome-node" ? { transport, nodeId: "transcript-node" } : {}),
          ...(finalize === undefined ? {} : { finalize }),
          meetingUrl: MEET_URL,
          meetingSessionId: "transcript-session",
          tab: { targetId: "transcript-tab", openedByPlugin: false },
        });
        const expectedLines = finalize === true ? [committed, visible] : [committed];
        expect(result).toStrictEqual({
          droppedLines: 0,
          epoch: "caption-epoch",
          lines: expectedLines,
        });
        expect(captionState.lines).toEqual(expectedLines);
        expect(captionState.visible).toEqual(finalize === true ? [] : [visible]);
        const params = {
          method: "POST",
          path: "/act",
          body: { kind: "evaluate", targetId: "transcript-tab", fn: expect.any(String) },
          timeoutMs,
        };
        if (transport === "chrome-node") {
          expect(browserCalls).toStrictEqual([]);
          expect(nodeCalls).toStrictEqual([
            {
              nodeId: "transcript-node",
              command: "browser.proxy",
              params,
              timeoutMs: timeoutMs + 5_000,
              scopes: ["operator.admin"],
            },
          ]);
        } else {
          expect(nodeCalls).toStrictEqual([]);
          expect(browserCalls).toStrictEqual([
            {
              method: "browser.request",
              params,
              options: { timeoutMs: timeoutMs + 5_000, scopes: ["operator.admin"] },
            },
          ]);
        }
      } finally {
        now.mockRestore();
      }
    },
  );
});
