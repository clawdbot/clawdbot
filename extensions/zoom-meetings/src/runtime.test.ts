import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import { zoomMeetingsConfig } from "./config.js";
import { ZoomMeetingsRuntime } from "./runtime.js";

const resolveZoomMeetingsConfig = zoomMeetingsConfig.resolveConfig;

const URL = "https://zoom.us/j/12345678904?pwd=runtime";
const urlWithPasscode = (passcode: string) => URL.replace("runtime", passcode);

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

type RuntimeHarnessOptions = {
  inCall?: boolean;
  meetingEnded?: boolean;
  pendingReason?: "admission" | "passcode";
  tabOpen?: boolean;
};

const pendingManualAction = (reason: "admission" | "passcode") => ({
  reason: `zoom-${reason}-required`,
  message: reason === "admission" ? "Waiting for host admission." : "Enter the meeting passcode.",
});

function runtimeHarness(options?: RuntimeHarnessOptions) {
  const state = {
    tabOpen: options?.tabOpen ?? false,
    inCall: options?.inCall ?? true,
    meetingEnded: options?.meetingEnded ?? false,
    meetingEndedOnce: false,
    sessionConflict: false,
    tabListFailures: 0,
    targetId: "zoom-tab",
    tabUrl: URL,
  };
  const pendingReason = options?.pendingReason ?? "passcode";
  const browserTab = () => ({ targetId: state.targetId, title: "Zoom call", url: state.tabUrl });
  const browserResult = (value: Record<string, unknown>) => ({ result: JSON.stringify(value) });
  const gatewayRequest = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    if (params.path === "/tabs") {
      if (state.tabListFailures > 0) {
        state.tabListFailures -= 1;
        throw new Error("browser node unavailable");
      }
      return { tabs: state.tabOpen ? [browserTab()] : [] };
    }
    if (params.path === "/tabs/open") {
      state.tabOpen = true;
      const requestedUrl = (params.body as { url?: unknown } | undefined)?.url;
      state.tabUrl = typeof requestedUrl === "string" ? requestedUrl : URL;
      return browserTab();
    }
    if (params.path === "/tabs/focus") {
      return { ok: true };
    }
    if (params.path === "/act") {
      const rawFn = (params.body as { fn?: unknown } | undefined)?.fn;
      const fn = typeof rawFn === "string" ? rawFn : "";
      if (fn.includes("leaveAction")) {
        return browserResult({ departed: true, sessionMatched: true, urlMatched: true });
      }
      if (fn.includes("expectedSessionId")) {
        return browserResult({
          urlMatched: true,
          sessionMatched: true,
          droppedLines: 0,
          lines: state.sessionConflict ? [{ text: "Archived caption" }] : [],
        });
      }
      const reportedMeetingEnded = state.meetingEnded;
      if (state.meetingEndedOnce) {
        state.meetingEnded = false;
        state.meetingEndedOnce = false;
      }
      return browserResult({
        inCall: state.inCall,
        meetingEnded: reportedMeetingEnded,
        micMuted: true,
        cameraOff: true,
        ...(!state.inCall
          ? {
              ...(pendingReason === "admission" ? { lobbyWaiting: true } : {}),
              manualAction: pendingManualAction(pendingReason),
            }
          : {}),
        ...(state.sessionConflict && fn.includes("const allowSessionAdoption = false")
          ? {
              manualAction: {
                reason: "zoom-session-conflict",
                message: "This Zoom tab is owned by another active meeting session.",
              },
            }
          : {}),
        url: state.tabUrl,
        title: "Zoom call",
      });
    }
    if (params.method === "DELETE" && params.path === `/tabs/${state.targetId}`) {
      state.tabOpen = false;
      return { ok: true };
    }
    throw new Error(`unexpected browser request ${String(params.method)} ${String(params.path)}`);
  });
  return {
    gatewayRequest,
    runtime: {
      gateway: { isAvailable: vi.fn(async () => true), request: gatewayRequest },
    } as unknown as PluginRuntime,
    state,
  };
}

type RuntimeInstance = InstanceType<typeof ZoomMeetingsRuntime>;
type RuntimeHarness = ReturnType<typeof runtimeHarness>;

function runtimeFixture(
  options: {
    harness?: RuntimeHarnessOptions;
    config?: Parameters<typeof resolveZoomMeetingsConfig>[0];
    fullConfig?: ConstructorParameters<typeof ZoomMeetingsRuntime>[0]["fullConfig"];
  } = {},
) {
  const harness = runtimeHarness(options.harness);
  const runtime = new ZoomMeetingsRuntime({
    config: resolveZoomMeetingsConfig(
      options.config ?? {
        defaultMode: "transcribe",
        chrome: { waitForInCallMs: 1 },
      },
    ),
    fullConfig: options.fullConfig ?? {},
    runtime: harness.runtime,
    logger,
  });
  return { harness, runtime };
}

function browserRequests(harness: RuntimeHarness, path: string) {
  return harness.gatewayRequest.mock.calls.filter(([, params]) => params.path === path);
}

function browserActScripts(harness: RuntimeHarness, since = 0) {
  return harness.gatewayRequest.mock.calls
    .slice(since)
    .filter(([, params]) => params.path === "/act")
    .map(([, params]) => {
      const fn = (params.body as { fn?: unknown } | undefined)?.fn;
      return typeof fn === "string" ? fn : "";
    });
}

function joinMeeting(
  runtime: RuntimeInstance,
  request: Partial<Parameters<RuntimeInstance["join"]>[0]> = {},
) {
  return runtime.join({ url: URL, mode: "transcribe", ...request });
}

describe("Zoom meeting session flow", () => {
  it("joins, reuses, reports, snapshots, speaks safely, and leaves through core", async () => {
    const { harness, runtime } = runtimeFixture({
      fullConfig: { agents: { list: [{ id: "operator", default: true }] } },
    });

    const first = await joinMeeting(runtime);
    expect(first.session.agentId).toBe("operator");
    expect(first.session.chrome?.health).toMatchObject({ inCall: true, cameraOff: true });

    const reused = await joinMeeting(runtime, {
      url: `${URL.split("?")[0]}?context=%7b%22Tid%22%3a%22two%22%7d`,
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
    const transcriptActScripts = browserActScripts(harness, transcriptStartCall);
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
            manualAction: undefined,
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
    const { harness, runtime } = runtimeFixture({
      harness: { inCall: false, pendingReason: "admission" },
    });
    const joined = await joinMeeting(runtime);
    harness.state.inCall = true;
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
    const { harness, runtime } = runtimeFixture();
    const joined = await joinMeeting(runtime);
    harness.state.sessionConflict = true;
    harness.gatewayRequest.mockClear();

    expect(await runtime.transcript(joined.session.id)).toMatchObject({
      found: true,
      lines: [{ text: "Archived caption" }],
    });
    const actScripts = browserActScripts(harness);
    expect(actScripts).toHaveLength(2);
    expect(actScripts[0]).toContain("const allowSessionAdoption = false");
    expect(actScripts[1]).toContain("expectedSessionId");
  });

  it("recovers and leaves a manually opened tab when Chrome launching is disabled", async () => {
    const { harness, runtime } = runtimeFixture({
      harness: { tabOpen: true },
      config: {
        defaultMode: "transcribe",
        chrome: { launch: false, waitForInCallMs: 1 },
      },
    });

    const joined = await joinMeeting(runtime);
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
    const { harness, runtime } = runtimeFixture();
    const joined = await joinMeeting(runtime);
    harness.state.targetId = "zoom-tab-replaced";

    await runtime.status(joined.session.id);

    expect(joined.session.chrome?.browserTab).toEqual({
      openedByPlugin: false,
      targetId: "zoom-tab-replaced",
    });

    harness.state.targetId = "zoom-tab-replaced-again";
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
    const { harness, runtime } = runtimeFixture();
    const joined = await joinMeeting(runtime);
    harness.state.tabUrl = "https://zoom.us/";
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
    const { harness, runtime } = runtimeFixture();
    const joined = await joinMeeting(runtime);
    harness.state.tabOpen = false;

    const status = await runtime.status(joined.session.id);

    expect(status.session).toMatchObject({
      browserLeft: true,
      state: "ended",
      chrome: {
        browserTab: undefined,
        health: {
          inCall: false,
          manualAction: undefined,
          status: "browser-tab-missing",
        },
      },
    });
  });

  it.each([
    ["opens a new session instead of reusing one whose Zoom tab disappeared", "missing-tab"],
    [
      "opens a new session when browser verification of a reusable tab fails",
      "verification-failure",
    ],
    ["replaces a reusable session whose realtime bridge closed", "bridge-closed"],
    ["closes a host-ended tab before opening its replacement", "host-ended"],
  ] as const)("%s", async (_title, scenario) => {
    const { harness, runtime } = runtimeFixture({
      config: scenario === "verification-failure" ? { defaultMode: "transcribe" } : undefined,
    });
    const first = await joinMeeting(runtime);
    if (scenario === "missing-tab") {
      harness.state.tabOpen = false;
    } else if (scenario === "verification-failure") {
      harness.state.tabListFailures = 1;
    } else if (scenario === "bridge-closed") {
      Object.assign(first.session.chrome?.health ?? {}, { bridgeClosed: true });
    } else {
      harness.state.inCall = false;
      harness.state.meetingEnded = true;
      harness.state.meetingEndedOnce = true;
    }

    const replacement = await joinMeeting(runtime);

    expect(first.session.state).toBe("ended");
    expect(replacement.session.id).not.toBe(first.session.id);
    if (scenario !== "verification-failure") {
      expect(browserRequests(harness, "/tabs/open")).toHaveLength(2);
    }
  });

  it("rejects and closes the tab when the initial browser status is host-ended", async () => {
    const { harness, runtime } = runtimeFixture({
      harness: { inCall: false, meetingEnded: true },
    });

    await expect(joinMeeting(runtime)).rejects.toThrow("The Zoom meeting has already ended.");

    expect(runtime.list()).toEqual([]);
    expect(
      browserRequests(harness, "/tabs/zoom-tab").filter(([, params]) => params.method === "DELETE"),
    ).toHaveLength(1);
  });

  it("ends the active session when browser status confirms the host ended it", async () => {
    const { harness, runtime } = runtimeFixture();
    const joined = await joinMeeting(runtime);
    harness.state.inCall = false;
    harness.state.meetingEnded = true;

    const status = await runtime.status(joined.session.id);

    expect(status.session).toMatchObject({
      browserLeft: true,
      chrome: { health: { inCall: false, meetingEnded: true } },
      state: "ended",
    });
  });

  it("restarts a failed join when the corrected invite changes the passcode", async () => {
    const { harness, runtime } = runtimeFixture({ harness: { inCall: false } });
    const first = await joinMeeting(runtime, { url: urlWithPasscode("old") });

    const corrected = await joinMeeting(runtime, { url: urlWithPasscode("correct") });

    expect(corrected.session.id).not.toBe(first.session.id);
    expect(first.session.state).toBe("ended");
    expect(browserRequests(harness, "/tabs/open")).toHaveLength(2);
  });

  it("serializes concurrent corrected passcodes under the meeting join lock", async () => {
    const { harness, runtime } = runtimeFixture({ harness: { inCall: false } });
    const first = await joinMeeting(runtime, { url: urlWithPasscode("old") });

    const [second, third] = await Promise.all([
      joinMeeting(runtime, { url: urlWithPasscode("correct-one") }),
      joinMeeting(runtime, { url: urlWithPasscode("correct-two") }),
    ]);

    expect(first.session.state).toBe("ended");
    expect(second.session.state).toBe("ended");
    expect(third.session.state).toBe("active");
    expect(new Set([first.session.id, second.session.id, third.session.id]).size).toBe(3);
    expect(browserRequests(harness, "/tabs/open")).toHaveLength(3);
  });

  it("serializes cross-agent reassignment through the core join owner", async () => {
    const { harness, runtime } = runtimeFixture({ harness: { inCall: false } });
    const first = await joinMeeting(runtime, {
      agentId: "support",
      url: urlWithPasscode("old"),
    });

    const replacement = await joinMeeting(runtime, {
      agentId: "main",
      url: urlWithPasscode("correct"),
    });

    expect(first.session.state).toBe("ended");
    expect(replacement.session.agentId).toBe("main");
    expect(replacement.session.id).not.toBe(first.session.id);
    expect(browserRequests(harness, "/tabs/open")).toHaveLength(2);
  });
});
