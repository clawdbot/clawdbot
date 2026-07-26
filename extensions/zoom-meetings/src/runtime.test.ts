import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveZoomMeetingsConfig } from "./config.js";
import { ZoomMeetingsRuntime } from "./runtime.js";

const URL = "https://zoom.us/j/12345678904?pwd=runtime";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function runtimeHarness(options?: {
  inCall?: boolean;
  meetingEnded?: boolean;
  pendingReason?: "admission" | "passcode";
  tabOpen?: boolean;
}) {
  let tabOpen = options?.tabOpen ?? false;
  let inCall = options?.inCall ?? true;
  let meetingEnded = options?.meetingEnded ?? false;
  let meetingEndedOnce = false;
  const pendingReason = options?.pendingReason ?? "passcode";
  let sessionConflict = false;
  let tabListFailures = 0;
  let targetId = "zoom-tab";
  let tabUrl = URL;
  const gatewayRequest = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    if (params.path === "/tabs") {
      if (tabListFailures > 0) {
        tabListFailures -= 1;
        throw new Error("browser node unavailable");
      }
      return {
        tabs: tabOpen ? [{ targetId, title: "Zoom call", url: tabUrl }] : [],
      };
    }
    if (params.path === "/tabs/open") {
      tabOpen = true;
      const requestedUrl = (params.body as { url?: unknown } | undefined)?.url;
      tabUrl = typeof requestedUrl === "string" ? requestedUrl : URL;
      return { targetId, title: "Zoom call", url: tabUrl };
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
      const reportedMeetingEnded = meetingEnded;
      if (meetingEndedOnce) {
        meetingEnded = false;
        meetingEndedOnce = false;
      }
      return {
        result: JSON.stringify({
          inCall,
          meetingEnded: reportedMeetingEnded,
          micMuted: true,
          cameraOff: true,
          ...(!inCall
            ? {
                ...(pendingReason === "admission" ? { lobbyWaiting: true } : {}),
                manualActionRequired: true,
                manualActionReason:
                  pendingReason === "admission"
                    ? "zoom-admission-required"
                    : "zoom-passcode-required",
                manualActionMessage:
                  pendingReason === "admission"
                    ? "Waiting for host admission."
                    : "Enter the meeting passcode.",
              }
            : {}),
          ...(sessionConflict && fn.includes("const allowSessionAdoption = false")
            ? {
                manualActionRequired: true,
                manualActionReason: "zoom-session-conflict",
                manualActionMessage: "This Zoom tab is owned by another active meeting session.",
              }
            : {}),
          url: tabUrl,
          title: "Zoom call",
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
    closeTab() {
      tabOpen = false;
    },
    setSessionConflict(value: boolean) {
      sessionConflict = value;
    },
    setInCall(value: boolean) {
      inCall = value;
    },
    setMeetingEnded(value: boolean, behavior?: { once?: boolean }) {
      meetingEnded = value;
      meetingEndedOnce = value && behavior?.once === true;
    },
    failNextTabLists(count = 1) {
      tabListFailures = count;
    },
    setTargetId(value: string) {
      targetId = value;
    },
    setTabUrl(value: string) {
      tabUrl = value;
    },
  };
}

describe("Zoom meeting session flow", () => {
  it("joins, reuses, reports, snapshots, speaks safely, and leaves through core", async () => {
    const harness = runtimeHarness();
    const runtime = new ZoomMeetingsRuntime({
      config: resolveZoomMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { waitForInCallMs: 1 },
      }),
      fullConfig: { agents: { list: [{ id: "operator", default: true }] } },
      runtime: harness.runtime,
      logger,
    });

    const first = await runtime.join({ url: URL, mode: "transcribe" });
    expect(first.session.agentId).toBe("operator");
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
            inCall: false,
            manualActionRequired: false,
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

  it("adopts the in-call page statefully after host admission", async () => {
    const harness = runtimeHarness({ inCall: false, pendingReason: "admission" });
    const runtime = new ZoomMeetingsRuntime({
      config: resolveZoomMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { waitForInCallMs: 1 },
      }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });
    const joined = await runtime.join({ url: URL, mode: "transcribe" });
    harness.setInCall(true);
    harness.gatewayRequest.mockClear();

    const status = await runtime.status(joined.session.id);

    const statusScript = harness.gatewayRequest.mock.calls
      .filter(([, params]) => params.path === "/act")
      .map(([, params]) => (params.body as { fn?: unknown } | undefined)?.fn)
      .find((fn): fn is string => typeof fn === "string" && fn.includes("const readOnly"));
    expect(statusScript).toContain("const readOnly = false");
    expect(status.session?.chrome?.health).toMatchObject({ inCall: true });
  });

  it("reads an archived transcript without reclaiming a newer live tab owner", async () => {
    const harness = runtimeHarness();
    const runtime = new ZoomMeetingsRuntime({
      config: resolveZoomMeetingsConfig({
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
    const runtime = new ZoomMeetingsRuntime({
      config: resolveZoomMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { launch: false, waitForInCallMs: 1 },
      }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });

    const joined = await runtime.join({ url: URL, mode: "transcribe" });
    expect(joined.session.chrome).toMatchObject({
      browserTab: { openedByPlugin: false, targetId: "zoom-tab" },
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
    const runtime = new ZoomMeetingsRuntime({
      config: resolveZoomMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { waitForInCallMs: 1 },
      }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });
    const joined = await runtime.join({ url: URL, mode: "transcribe" });
    harness.setTargetId("zoom-tab-replaced");

    await runtime.status(joined.session.id);

    expect(joined.session.chrome?.browserTab).toEqual({
      openedByPlugin: false,
      targetId: "zoom-tab-replaced",
    });

    harness.setTargetId("zoom-tab-replaced-again");
    harness.gatewayRequest.mockClear();
    await runtime.transcript(joined.session.id);

    expect(joined.session.chrome?.browserTab).toEqual({
      openedByPlugin: false,
      targetId: "zoom-tab-replaced-again",
    });
    const transcriptRead = harness.gatewayRequest.mock.calls.find(([, params]) => {
      const fn = (params.body as { fn?: unknown } | undefined)?.fn;
      return params.path === "/act" && typeof fn === "string" && fn.includes("expectedSessionId");
    });
    expect(transcriptRead?.[1]).toMatchObject({
      body: { targetId: "zoom-tab-replaced-again" },
    });
  });

  it("recovers the tracked tab after Zoom rewrites the in-call URL", async () => {
    const harness = runtimeHarness();
    const runtime = new ZoomMeetingsRuntime({
      config: resolveZoomMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { waitForInCallMs: 1 },
      }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });
    const joined = await runtime.join({ url: URL, mode: "transcribe" });
    harness.setTabUrl("https://zoom.us/");
    harness.gatewayRequest.mockClear();

    const status = await runtime.status(joined.session.id);

    expect(status.session?.chrome?.health?.browserUrl).toBe("https://zoom.us/");
    expect(harness.gatewayRequest).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        path: "/act",
        body: expect.objectContaining({ targetId: "zoom-tab" }),
      }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
  });

  it("ends the session when the tracked Zoom tab disappears", async () => {
    const harness = runtimeHarness();
    const runtime = new ZoomMeetingsRuntime({
      config: resolveZoomMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { waitForInCallMs: 1 },
      }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });
    const joined = await runtime.join({ url: URL, mode: "transcribe" });
    harness.closeTab();

    const status = await runtime.status(joined.session.id);

    expect(status.session).toMatchObject({
      browserLeft: true,
      state: "ended",
      chrome: {
        browserTab: undefined,
        health: {
          inCall: false,
          manualActionReason: undefined,
          manualActionRequired: false,
          status: "browser-tab-missing",
        },
      },
    });
  });

  it("opens a new session instead of reusing one whose Zoom tab disappeared", async () => {
    const harness = runtimeHarness();
    const runtime = new ZoomMeetingsRuntime({
      config: resolveZoomMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { waitForInCallMs: 1 },
      }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });
    const first = await runtime.join({ url: URL, mode: "transcribe" });
    harness.closeTab();

    const replacement = await runtime.join({ url: URL, mode: "transcribe" });

    expect(first.session.state).toBe("ended");
    expect(replacement.session.id).not.toBe(first.session.id);
    expect(
      harness.gatewayRequest.mock.calls.filter(([, params]) => params.path === "/tabs/open"),
    ).toHaveLength(2);
  });

  it("opens a new session when browser verification of a reusable tab fails", async () => {
    const harness = runtimeHarness();
    const runtime = new ZoomMeetingsRuntime({
      config: resolveZoomMeetingsConfig({ defaultMode: "transcribe" }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });
    const first = await runtime.join({ url: URL, mode: "transcribe" });
    harness.failNextTabLists();

    const replacement = await runtime.join({ url: URL, mode: "transcribe" });

    expect(first.session.state).toBe("ended");
    expect(replacement.session.id).not.toBe(first.session.id);
  });

  it("replaces a reusable session whose realtime bridge closed", async () => {
    const harness = runtimeHarness();
    const runtime = new ZoomMeetingsRuntime({
      config: resolveZoomMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { waitForInCallMs: 1 },
      }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });
    const first = await runtime.join({ url: URL, mode: "transcribe" });
    Object.assign(first.session.chrome?.health ?? {}, { bridgeClosed: true });

    const replacement = await runtime.join({ url: URL, mode: "transcribe" });

    expect(first.session.state).toBe("ended");
    expect(replacement.session.id).not.toBe(first.session.id);
    expect(
      harness.gatewayRequest.mock.calls.filter(([, params]) => params.path === "/tabs/open"),
    ).toHaveLength(2);
  });

  it("closes a host-ended tab before opening its replacement", async () => {
    const harness = runtimeHarness();
    const runtime = new ZoomMeetingsRuntime({
      config: resolveZoomMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { waitForInCallMs: 1 },
      }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });
    const first = await runtime.join({ url: URL, mode: "transcribe" });
    harness.setInCall(false);
    harness.setMeetingEnded(true, { once: true });

    const replacement = await runtime.join({ url: URL, mode: "transcribe" });

    expect(first.session.state).toBe("ended");
    expect(replacement.session.id).not.toBe(first.session.id);
    expect(
      harness.gatewayRequest.mock.calls.filter(([, params]) => params.path === "/tabs/open"),
    ).toHaveLength(2);
  });

  it("rejects and closes the tab when the initial browser status is host-ended", async () => {
    const harness = runtimeHarness({ inCall: false, meetingEnded: true });
    const runtime = new ZoomMeetingsRuntime({
      config: resolveZoomMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { waitForInCallMs: 1 },
      }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });

    await expect(runtime.join({ url: URL, mode: "transcribe" })).rejects.toThrow(
      "The Zoom meeting has already ended.",
    );

    expect(runtime.list()).toEqual([]);
    expect(
      harness.gatewayRequest.mock.calls.filter(
        ([, params]) => params.method === "DELETE" && params.path === "/tabs/zoom-tab",
      ),
    ).toHaveLength(1);
  });

  it("ends the active session when browser status confirms the host ended it", async () => {
    const harness = runtimeHarness();
    const runtime = new ZoomMeetingsRuntime({
      config: resolveZoomMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { waitForInCallMs: 1 },
      }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });
    const joined = await runtime.join({ url: URL, mode: "transcribe" });
    harness.setInCall(false);
    harness.setMeetingEnded(true);

    const status = await runtime.status(joined.session.id);

    expect(status.session).toMatchObject({
      browserLeft: true,
      chrome: { health: { inCall: false, meetingEnded: true } },
      state: "ended",
    });
  });

  it("restarts a failed join when the corrected invite changes the passcode", async () => {
    const harness = runtimeHarness({ inCall: false });
    const runtime = new ZoomMeetingsRuntime({
      config: resolveZoomMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { waitForInCallMs: 1 },
      }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });
    const first = await runtime.join({
      mode: "transcribe",
      url: "https://zoom.us/j/12345678904?pwd=old",
    });

    const corrected = await runtime.join({
      mode: "transcribe",
      url: "https://zoom.us/j/12345678904?pwd=correct",
    });

    expect(corrected.session.id).not.toBe(first.session.id);
    expect(first.session.state).toBe("ended");
    expect(
      harness.gatewayRequest.mock.calls.filter(([, params]) => params.path === "/tabs/open"),
    ).toHaveLength(2);
  });

  it("serializes concurrent corrected passcodes under the meeting join lock", async () => {
    const harness = runtimeHarness({ inCall: false });
    const runtime = new ZoomMeetingsRuntime({
      config: resolveZoomMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { waitForInCallMs: 1 },
      }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });
    const first = await runtime.join({
      mode: "transcribe",
      url: "https://zoom.us/j/12345678904?pwd=old",
    });

    const [second, third] = await Promise.all([
      runtime.join({
        mode: "transcribe",
        url: "https://zoom.us/j/12345678904?pwd=correct-one",
      }),
      runtime.join({
        mode: "transcribe",
        url: "https://zoom.us/j/12345678904?pwd=correct-two",
      }),
    ]);

    expect(first.session.state).toBe("ended");
    expect(second.session.state).toBe("ended");
    expect(third.session.state).toBe("active");
    expect(new Set([first.session.id, second.session.id, third.session.id]).size).toBe(3);
    expect(
      harness.gatewayRequest.mock.calls.filter(([, params]) => params.path === "/tabs/open"),
    ).toHaveLength(3);
  });

  it("serializes cross-agent reassignment through the core join owner", async () => {
    const harness = runtimeHarness({ inCall: false });
    const runtime = new ZoomMeetingsRuntime({
      config: resolveZoomMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { waitForInCallMs: 1 },
      }),
      fullConfig: {},
      runtime: harness.runtime,
      logger,
    });
    const first = await runtime.join({
      agentId: "support",
      mode: "transcribe",
      url: "https://zoom.us/j/12345678904?pwd=old",
    });

    const replacement = await runtime.join({
      agentId: "main",
      mode: "transcribe",
      url: "https://zoom.us/j/12345678904?pwd=correct",
    });

    expect(first.session.state).toBe("ended");
    expect(replacement.session.agentId).toBe("main");
    expect(replacement.session.id).not.toBe(first.session.id);
    expect(
      harness.gatewayRequest.mock.calls.filter(([, params]) => params.path === "/tabs/open"),
    ).toHaveLength(2);
  });
});
