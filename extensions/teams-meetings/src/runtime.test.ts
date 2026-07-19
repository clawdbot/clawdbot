import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveTeamsMeetingsConfig } from "./config.js";
import { TeamsMeetingsRuntime } from "./runtime.js";

const URL =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_runtime%40thread.v2/0?context=%7b%22Tid%22%3a%22one%22%7d";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function runtimeHarness(options?: { tabOpen?: boolean }) {
  let tabOpen = options?.tabOpen ?? false;
  let sessionConflict = false;
  let targetId = "teams-tab";
  let tabUrl = URL;
  const gatewayRequest = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    if (params.path === "/tabs") {
      return {
        tabs: tabOpen ? [{ targetId, title: "Teams call", url: tabUrl }] : [],
      };
    }
    if (params.path === "/tabs/open") {
      tabOpen = true;
      tabUrl = URL;
      return { targetId, title: "Teams call", url: tabUrl };
    }
    if (params.path === "/tabs/focus") {
      return { ok: true };
    }
    if (params.path === "/act") {
      const rawFn = (params.body as { fn?: unknown } | undefined)?.fn;
      const fn = typeof rawFn === "string" ? rawFn : "";
      if (fn.includes("leaveAction")) {
        return {
          result: JSON.stringify({ departed: true, sessionMatched: true, urlMatched: true }),
        };
      }
      if (fn.includes("expectedSessionId")) {
        return {
          result: JSON.stringify({
            urlMatched: true,
            sessionMatched: true,
            droppedLines: 0,
            lines: sessionConflict ? [{ text: "Archived caption" }] : [],
          }),
        };
      }
      return {
        result: JSON.stringify({
          inCall: true,
          micMuted: true,
          cameraOff: true,
          ...(sessionConflict && fn.includes("const allowSessionAdoption = false")
            ? {
                manualActionRequired: true,
                manualActionReason: "teams-session-conflict",
                manualActionMessage: "This Teams tab is owned by another active meeting session.",
              }
            : {}),
          url: tabUrl,
          title: "Teams call",
        }),
      };
    }
    if (params.method === "DELETE" && params.path === `/tabs/${targetId}`) {
      tabOpen = false;
      return { ok: true };
    }
    throw new Error(`unexpected browser request ${String(params.method)} ${String(params.path)}`);
  });
  const runtime = {
    gateway: {
      isAvailable: vi.fn(async () => true),
      request: gatewayRequest,
    },
    system: {
      runCommandWithTimeout: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    },
  } as unknown as PluginRuntime;
  return {
    runtime,
    gatewayRequest,
    setSessionConflict(value: boolean) {
      sessionConflict = value;
    },
    setTargetId(value: string) {
      targetId = value;
    },
    setTabUrl(value: string) {
      tabUrl = value;
    },
  };
}

describe("Microsoft Teams meeting session flow", () => {
  it("joins, reuses, reports, snapshots, speaks safely, and leaves through core", async () => {
    const harness = runtimeHarness();
    const runtime = new TeamsMeetingsRuntime({
      config: resolveTeamsMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { waitForInCallMs: 1 },
      }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });

    const first = await runtime.join({ url: URL, mode: "transcribe" });
    expect(first.session.chrome?.health).toMatchObject({ inCall: true, cameraOff: true });

    const reused = await runtime.join({
      url: `${URL.split("?")[0]}?context=%7b%22Tid%22%3a%22two%22%7d`,
      mode: "transcribe",
    });
    expect(reused.session.id).toBe(first.session.id);
    expect(runtime.list()).toHaveLength(1);

    expect(await runtime.status(first.session.id)).toMatchObject({
      found: true,
      session: { id: first.session.id },
    });
    const transcriptStartCall = harness.gatewayRequest.mock.calls.length;
    expect(await runtime.transcript(first.session.id)).toMatchObject({
      found: true,
      lines: [],
      nextIndex: 0,
    });
    const transcriptActScripts = harness.gatewayRequest.mock.calls
      .slice(transcriptStartCall)
      .filter(([, params]) => params.path === "/act")
      .map(([, params]) => {
        const fn = (params.body as { fn?: unknown } | undefined)?.fn;
        return typeof fn === "string" ? fn : "";
      });
    expect(transcriptActScripts).toHaveLength(2);
    expect(transcriptActScripts[0]).toContain("const allowSessionAdoption = false");
    expect(transcriptActScripts[0]).toContain("const captureCaptions = true");
    expect(transcriptActScripts[1]).toContain("expectedSessionId");
    expect(await runtime.speak(first.session.id, "hello")).toMatchObject({
      found: true,
      spoken: false,
    });
    Object.assign(first.session.chrome?.health ?? {}, {
      audioInputActive: true,
      audioInputRouted: true,
      audioOutputActive: true,
      audioOutputRouted: true,
      captioning: true,
      providerConnected: true,
      realtimeReady: true,
    });
    expect(await runtime.leave(first.session.id)).toMatchObject({
      found: true,
      browserLeft: true,
      session: {
        state: "ended",
        chrome: {
          health: {
            audioInputActive: false,
            audioInputRouted: false,
            audioOutputActive: false,
            audioOutputRouted: false,
            captioning: false,
            providerConnected: false,
            realtimeReady: false,
          },
        },
      },
    });
    expect(harness.gatewayRequest).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({ path: "/tabs/open" }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
  });

  it("reads an archived transcript without reclaiming a newer live tab owner", async () => {
    const harness = runtimeHarness();
    const runtime = new TeamsMeetingsRuntime({
      config: resolveTeamsMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { waitForInCallMs: 1 },
      }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });
    const joined = await runtime.join({ url: URL, mode: "transcribe" });
    harness.setSessionConflict(true);
    harness.gatewayRequest.mockClear();

    expect(await runtime.transcript(joined.session.id)).toMatchObject({
      found: true,
      lines: [{ text: "Archived caption" }],
    });
    const actScripts = harness.gatewayRequest.mock.calls
      .filter(([, params]) => params.path === "/act")
      .map(([, params]) => {
        const fn = (params.body as { fn?: unknown } | undefined)?.fn;
        return typeof fn === "string" ? fn : "";
      });
    expect(actScripts).toHaveLength(2);
    expect(actScripts[0]).toContain("const allowSessionAdoption = false");
    expect(actScripts[1]).toContain("expectedSessionId");
  });

  it("recovers and leaves a manually opened tab when Chrome launching is disabled", async () => {
    const harness = runtimeHarness({ tabOpen: true });
    const runtime = new TeamsMeetingsRuntime({
      config: resolveTeamsMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { launch: false, waitForInCallMs: 1 },
      }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });

    const joined = await runtime.join({ url: URL, mode: "transcribe" });
    expect(joined.session.chrome).toMatchObject({
      browserTab: { openedByPlugin: false, targetId: "teams-tab" },
      launched: false,
    });
    expect(harness.gatewayRequest).not.toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({ path: "/tabs/open" }),
      expect.anything(),
    );
    expect(await runtime.leave(joined.session.id)).toMatchObject({
      browserLeft: true,
      session: { state: "ended" },
    });
  });

  it("refreshes a recovered browser tab target", async () => {
    const harness = runtimeHarness();
    const runtime = new TeamsMeetingsRuntime({
      config: resolveTeamsMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { waitForInCallMs: 1 },
      }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });
    const joined = await runtime.join({ url: URL, mode: "transcribe" });
    harness.setTargetId("teams-tab-replaced");

    await runtime.status(joined.session.id);

    expect(joined.session.chrome?.browserTab).toEqual({
      openedByPlugin: false,
      targetId: "teams-tab-replaced",
    });

    harness.setTargetId("teams-tab-replaced-again");
    harness.gatewayRequest.mockClear();
    await runtime.transcript(joined.session.id);

    expect(joined.session.chrome?.browserTab).toEqual({
      openedByPlugin: false,
      targetId: "teams-tab-replaced-again",
    });
    const transcriptRead = harness.gatewayRequest.mock.calls.find(([, params]) => {
      const fn = (params.body as { fn?: unknown } | undefined)?.fn;
      return params.path === "/act" && typeof fn === "string" && fn.includes("expectedSessionId");
    });
    expect(transcriptRead?.[1]).toMatchObject({
      body: { targetId: "teams-tab-replaced-again" },
    });
  });

  it("recovers the tracked tab after Teams rewrites the in-call URL", async () => {
    const harness = runtimeHarness();
    const runtime = new TeamsMeetingsRuntime({
      config: resolveTeamsMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { waitForInCallMs: 1 },
      }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });
    const joined = await runtime.join({ url: URL, mode: "transcribe" });
    harness.setTabUrl("https://teams.microsoft.com/v2/");
    harness.gatewayRequest.mockClear();

    const status = await runtime.status(joined.session.id);

    expect(status.session?.chrome?.health?.browserUrl).toBe("https://teams.microsoft.com/v2/");
    expect(harness.gatewayRequest).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        path: "/act",
        body: expect.objectContaining({ targetId: "teams-tab" }),
      }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
  });
});
