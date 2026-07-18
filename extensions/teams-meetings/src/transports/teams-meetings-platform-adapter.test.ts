import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  teamsMeetingLeaveScript,
  teamsMeetingStatusScript,
} from "./teams-meetings-page-scripts.js";
import {
  TEAMS_MEETINGS_PLATFORM_ADAPTER,
  isTeamsMeetingsRealtimeRouteReady,
} from "./teams-meetings-platform-adapter.js";

const URL =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_test%40thread.v2/0?context=%7b%7d";
const MEETING_STATE_KEY = "__openclawTeamsMeeting";

function status(manualActionReason: string, manualActionMessage = "manual action") {
  const health = TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.parseStatus({
    result: JSON.stringify({
      inCall: false,
      manualActionRequired: true,
      manualActionReason,
      manualActionMessage,
      url: URL,
    }),
  });
  if (!health) {
    throw new Error("expected parsed health");
  }
  return health;
}

type PageControl = {
  disabled?: boolean;
  clicks: number;
  isConnected: boolean;
  click(): void;
  closest(selector?: string): PageControl;
  getAttribute(name: string): string | null;
  matches(selector: string): boolean;
  querySelector(): undefined;
  querySelectorAll?(selector: string): PageControl[];
  setPressed(pressed: boolean): void;
  textContent: string;
};

function control(params: {
  label: string;
  pressed?: boolean;
  onClick?: (control: PageControl) => void;
}): PageControl {
  const attributes = new Map<string, string>([["aria-label", params.label]]);
  if (params.pressed !== undefined) {
    attributes.set("aria-pressed", String(params.pressed));
  }
  const node: PageControl = {
    clicks: 0,
    isConnected: true,
    textContent: "",
    click() {
      node.clicks += 1;
      params.onClick?.(node);
    },
    closest: () => node,
    getAttribute: (name) => attributes.get(name) ?? null,
    matches: (selector) => selector === "button",
    querySelector: () => undefined,
    setPressed: (pressed) => attributes.set("aria-pressed", String(pressed)),
  };
  return node;
}

async function runStatusScript(params: {
  allowMicrophone: boolean;
  bodyText?: string;
  currentUrl?: string;
  microphone?: PageControl;
  camera?: PageControl;
  join?: PageControl;
  leave?: PageControl;
  microphoneDevice?: PageControl;
  permissionPrompt?: PageControl;
  priorMeeting?: Record<string, unknown>;
  readOnly?: boolean;
  globalSelectedOption?: PageControl;
  media?: Array<{ sinkId: string; setSinkId(value: string): Promise<void> }>;
  devices?: Array<{ deviceId: string; kind: string; label: string }>;
}) {
  const currentUrl = params.currentUrl ?? URL;
  const location = new globalThis.URL(currentUrl);
  const controls = [params.microphone, params.camera, params.join, params.leave].filter(
    (entry): entry is PageControl => Boolean(entry),
  );
  const document = {
    body: { textContent: params.bodyText ?? "" },
    title: "Teams",
    getElementById() {
      return undefined;
    },
    querySelector(selector: string) {
      if (selector.includes("toggle-mute")) {
        return params.microphone;
      }
      if (selector.includes("toggle-video")) {
        return params.camera;
      }
      if (selector.includes("prejoin-join-button")) {
        return params.join;
      }
      if (selector.includes("call-hangup")) {
        return params.leave;
      }
      if (
        selector.includes("microphone-select") ||
        selector.includes("audio-device-input") ||
        selector.includes("device-settings-microphone")
      ) {
        return params.microphoneDevice;
      }
      if (selector.includes("permission-prompt") || selector.includes("permission-error")) {
        return params.permissionPrompt;
      }
      if (selector === '[role="option"][aria-selected="true"]') {
        return params.globalSelectedOption;
      }
      return undefined;
    },
    querySelectorAll(selector: string) {
      if (selector === "button") {
        return controls;
      }
      if (selector === "audio, video") {
        return params.media ?? [];
      }
      if (selector.includes('[role="option"]')) {
        return params.globalSelectedOption ? [params.globalSelectedOption] : [];
      }
      return [];
    },
  };
  const window: Record<string, unknown> = {};
  if (params.priorMeeting) {
    window[MEETING_STATE_KEY] = params.priorMeeting;
  }
  const script = teamsMeetingStatusScript({
    allowMicrophone: params.allowMicrophone,
    autoJoin: true,
    guestName: "OpenClaw Guest",
    meetingSessionId: "session-1",
    meetingUrl: URL,
    readOnly: params.readOnly,
  });
  const run = runInNewContext(`(${script})`, {
    Event: globalThis.Event,
    HTMLInputElement: function HTMLInputElement() {},
    URL: globalThis.URL,
    document,
    location,
    navigator: {
      mediaDevices: {
        enumerateDevices: async () => params.devices ?? [],
      },
    },
    setTimeout,
    window,
  }) as () => Promise<string>;
  return { result: JSON.parse(await run()) as Record<string, unknown>, window };
}

function runLeaveScript(params: {
  bodyText?: string;
  currentUrl?: string;
  leave?: PageControl;
  postCall?: PageControl;
  priorMeeting?: Record<string, unknown>;
}) {
  const currentUrl = params.currentUrl ?? URL;
  const location = new globalThis.URL(currentUrl);
  const document = {
    body: { textContent: params.bodyText ?? "" },
    querySelector(selector: string) {
      if (selector.includes("call-hangup")) {
        return params.leave;
      }
      if (
        selector.includes("call-ended-screen") ||
        selector.includes("post-call-screen") ||
        selector.includes("prejoin-rejoin-button")
      ) {
        return params.postCall;
      }
      return undefined;
    },
  };
  const window: Record<string, unknown> = {};
  if (params.priorMeeting) {
    window[MEETING_STATE_KEY] = params.priorMeeting;
  }
  const run = runInNewContext(`(${teamsMeetingLeaveScript(URL)})`, {
    URL: globalThis.URL,
    document,
    location,
    window,
  }) as () => string;
  return { result: JSON.parse(run()) as Record<string, unknown>, window };
}

describe("Microsoft Teams meeting platform adapter", () => {
  it.each([
    ["teams-login-required", "login-required"],
    ["teams-admission-required", "admission-required"],
    ["teams-permission-required", "permission-required"],
    ["teams-audio-choice-required", "audio-choice-required"],
    ["teams-session-conflict", "session-conflict"],
    ["browser-control-unavailable", "browser-control-unavailable"],
  ])("classifies %s as %s", (reason, category) => {
    expect(TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.classifyManualAction(status(reason))).toEqual({
      category,
      reason,
      message: "manual action",
    });
  });

  it.each([
    ["camera", "Turn camera off", undefined, "on"],
    ["camera", "Turn camera on", undefined, "off"],
    ["camera", "Stop video", undefined, "on"],
    ["camera", "Start video", undefined, "off"],
    ["camera", "Turn camera on", "true", "on"],
    ["microphone", "Mute", undefined, "on"],
    ["microphone", "Unmute", undefined, "off"],
    ["microphone", "Turn microphone off", undefined, "on"],
    ["microphone", "Turn microphone on", undefined, "off"],
    ["microphone", "Microphone is muted", undefined, "off"],
    ["microphone", "Turn microphone off", "false", "off"],
  ])(
    "parses %s control %j with aria-pressed %j as %s",
    async (kind, label, ariaPressed, expected) => {
      const target = control({
        label,
        ...(ariaPressed === undefined ? {} : { pressed: ariaPressed === "true" }),
      });
      const { result } = await runStatusScript({
        allowMicrophone: false,
        ...(kind === "camera" ? { camera: target } : { microphone: target }),
        readOnly: true,
      });
      expect(kind === "camera" ? result.cameraOff : result.micMuted).toBe(expected === "off");
    },
  );

  it("re-reads camera and microphone state after toggling before joining", async () => {
    const camera = control({
      label: "Turn camera off",
      pressed: true,
      onClick: (node) => node.setPressed(false),
    });
    const microphone = control({
      label: "Turn microphone off",
      pressed: true,
      onClick: (node) => node.setPressed(false),
    });
    const join = control({ label: "Join now" });

    const { result } = await runStatusScript({
      allowMicrophone: false,
      camera,
      join,
      microphone,
    });

    expect(result).toMatchObject({ cameraOff: true, clickedJoin: true, micMuted: true });
    expect(camera.clicks).toBe(1);
    expect(microphone.clicks).toBe(1);
    expect(join.clicks).toBe(1);
  });

  it("does not unmute or join until BlackHole is visibly selected as the Teams input", async () => {
    const camera = control({ label: "Turn camera on", pressed: false });
    const microphone = control({ label: "Turn microphone on", pressed: false });
    const join = control({ label: "Join now" });

    const { result } = await runStatusScript({
      allowMicrophone: true,
      camera,
      devices: [{ deviceId: "blackhole", kind: "audioinput", label: "BlackHole 2ch" }],
      join,
      microphone,
    });

    expect(result).toMatchObject({
      audioInputRouted: false,
      clickedJoin: false,
      manualActionReason: "teams-audio-choice-required",
      micMuted: true,
    });
    expect(microphone.clicks).toBe(0);
    expect(join.clicks).toBe(0);
  });

  it("does not auto-join talk-back when the microphone control is missing", async () => {
    const camera = control({ label: "Turn camera on", pressed: false });
    const join = control({ label: "Join now" });

    const { result } = await runStatusScript({
      allowMicrophone: true,
      camera,
      join,
    });

    expect(result).toMatchObject({
      manualActionReason: "teams-microphone-required",
      manualActionRequired: true,
    });
    expect(join.clicks).toBe(0);
  });

  it("does not accept a selected BlackHole speaker option as the microphone", async () => {
    const camera = control({ label: "Turn camera on", pressed: false });
    const microphone = control({ label: "Turn microphone on", pressed: false });
    const microphoneDevice = control({ label: "MacBook Pro Microphone" });
    const selectedSpeaker = control({ label: "BlackHole 2ch" });
    const join = control({ label: "Join now" });

    const { result } = await runStatusScript({
      allowMicrophone: true,
      camera,
      devices: [{ deviceId: "blackhole", kind: "audioinput", label: "BlackHole 2ch" }],
      globalSelectedOption: selectedSpeaker,
      join,
      microphone,
      microphoneDevice,
    });

    expect(result).toMatchObject({
      audioInputRouted: false,
      clickedJoin: false,
      manualActionReason: "teams-audio-choice-required",
    });
    expect(microphone.clicks).toBe(0);
  });

  it("does not stamp meeting identity onto unrelated Teams pages", async () => {
    const leave = control({ label: "Leave" });
    const { result, window } = await runStatusScript({
      allowMicrophone: false,
      currentUrl: "https://teams.microsoft.com/v2/",
      leave,
    });

    expect(result.inCall).toBe(false);
    expect(window).not.toHaveProperty("__openclawTeamsMeeting");
  });

  it("preserves a verified identity only across an in-call URL transition", async () => {
    const leave = control({ label: "Leave" });
    const inCallUrl = "https://teams.microsoft.com/v2/";
    const priorMeeting = {
      identity: "teams-work:19:meeting_test@thread.v2",
      inCallControl: leave,
      inCallUrl,
      sessionId: "session-1",
    };
    const { result, window } = await runStatusScript({
      allowMicrophone: false,
      currentUrl: inCallUrl,
      leave,
      priorMeeting,
    });

    expect(result.inCall).toBe(true);
    expect(window[MEETING_STATE_KEY]).toMatchObject(priorMeeting);
  });

  it("adopts the first live hang-up control during the verified join transition", async () => {
    const prejoin = await runStatusScript({ allowMicrophone: false });
    const leave = control({ label: "Leave" });
    const admitted = await runStatusScript({
      allowMicrophone: false,
      currentUrl: "https://teams.microsoft.com/v2/",
      leave,
      priorMeeting: prejoin.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });

    expect(admitted.result.inCall).toBe(true);
    expect(admitted.window[MEETING_STATE_KEY]).toMatchObject({
      identity: "teams-work:19:meeting_test@thread.v2",
      inCallControl: leave,
      inCallUrl: "https://teams.microsoft.com/v2/",
    });
  });

  it("re-adopts a replaced hang-up control only within the bounded rerender window", async () => {
    const previousLeave = control({ label: "Leave" });
    previousLeave.isConnected = false;
    const currentLeave = control({ label: "Leave" });
    const inCallUrl = "https://teams.microsoft.com/v2/";
    const { result, window } = await runStatusScript({
      allowMicrophone: false,
      currentUrl: inCallUrl,
      leave: currentLeave,
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        inCallControl: previousLeave,
        inCallUrl,
        verifiedAt: Date.now(),
      },
    });

    expect(result.inCall).toBe(true);
    expect(window[MEETING_STATE_KEY]).toMatchObject({
      inCallControl: currentLeave,
      inCallUrl,
    });
  });

  it("does not trust a stale identity marker to leave a different SPA call", () => {
    const staleLeave = control({ label: "Leave old call" });
    const currentLeave = control({ label: "Leave current call" });
    const { result } = runLeaveScript({
      currentUrl: "https://teams.microsoft.com/v2/",
      leave: currentLeave,
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        inCallControl: staleLeave,
        inCallUrl: "https://teams.microsoft.com/v2/",
      },
    });

    expect(result).toEqual({ departed: false, urlMatched: false });
    expect(currentLeave.clicks).toBe(0);
  });

  it.each([
    "Alice: meeting ended — rejoin after lunch",
    "Bob: allow Teams to use your microphone; device permissions are blocked",
  ])("ignores participant-controlled in-call text: %s", async (bodyText) => {
    const leave = control({ label: "Leave" });
    const { result } = await runStatusScript({
      allowMicrophone: false,
      bodyText,
      leave,
    });

    expect(result).toMatchObject({
      inCall: true,
      manualActionRequired: false,
    });
  });

  it("classifies a stable device permission prompt outside the call", async () => {
    const { result } = await runStatusScript({
      allowMicrophone: false,
      permissionPrompt: control({ label: "Device permission prompt" }),
    });

    expect(result).toMatchObject({
      inCall: false,
      manualActionReason: "teams-permission-required",
      manualActionRequired: true,
    });
  });

  it.each(["meeting ended", "call ended — rejoin"])(
    "does not infer departure from page-wide text: %s",
    (bodyText) => {
      const { result } = runLeaveScript({ bodyText });
      expect(result).toEqual({ departed: false, urlMatched: true });
    },
  );

  it("requires positive input and output route evidence before realtime", () => {
    expect(
      isTeamsMeetingsRealtimeRouteReady("agent", {
        audioInputRouted: true,
        audioOutputRouted: true,
        inCall: true,
        micMuted: false,
      }),
    ).toBe(true);
    for (const health of [
      { audioOutputRouted: true, inCall: true, micMuted: false },
      { audioInputRouted: true, inCall: true, micMuted: false },
      { audioInputRouted: true, audioOutputRouted: true, inCall: true },
    ]) {
      expect(isTeamsMeetingsRealtimeRouteReady("agent", health)).toBe(false);
    }
    expect(
      isTeamsMeetingsRealtimeRouteReady("transcribe", {
        audioInputRouted: true,
        audioOutputRouted: true,
        inCall: true,
        micMuted: false,
      }),
    ).toBe(false);
  });

  it("reports verified routes only after the exact input marker and output sink agree", async () => {
    const leave = control({ label: "Leave" });
    const microphone = control({ label: "Turn microphone off", pressed: true });
    const media = {
      sinkId: "",
      async setSinkId(value: string) {
        media.sinkId = value;
      },
    };
    const { result } = await runStatusScript({
      allowMicrophone: true,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave,
      media: [media],
      microphone,
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: {
        audioInputDeviceId: "blackhole-input",
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    });

    expect(result).toMatchObject({
      audioInputRouted: true,
      audioOutputRouted: true,
      inCall: true,
      manualActionRequired: false,
      micMuted: false,
    });
    expect(media.sinkId).toBe("blackhole-output");
  });

  it("mutes an in-call physical microphone when Teams resets the prejoin selection", async () => {
    const microphone = control({
      label: "Turn microphone off",
      pressed: true,
      onClick: (node) => node.setPressed(false),
    });
    const { result } = await runStatusScript({
      allowMicrophone: true,
      devices: [{ deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" }],
      leave: control({ label: "Leave" }),
      microphone,
      microphoneDevice: control({ label: "MacBook Pro Microphone" }),
      priorMeeting: {
        audioInputDeviceId: "blackhole-input",
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    });

    expect(result).toMatchObject({
      audioInputRouted: false,
      manualActionReason: "teams-audio-choice-required",
      micMuted: true,
    });
    expect(microphone.clicks).toBe(1);
  });

  it("builds the guest join script from centralized stable selectors and text fallbacks", () => {
    const script = teamsMeetingStatusScript({
      allowMicrophone: true,
      autoJoin: true,
      guestName: "OpenClaw Guest",
      meetingSessionId: "session-1",
      meetingUrl: URL,
    });
    expect(script).toContain('data-tid=\\"prejoin-display-name-input\\"');
    expect(script).toContain('data-tid=\\"call-hangup\\"');
    expect(script).toContain("continue on this browser");
    expect(script).toContain("someone will let you in shortly");
    expect(script).toContain("setSinkId");
    expect(script).toContain("BlackHole");
  });

  it("keeps caption capture disabled and returns empty snapshots", () => {
    expect(TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.captions.enabled("transcribe")).toBe(false);
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.captions.parseTranscript({
        result: JSON.stringify({ urlMatched: true, sessionMatched: true, lines: ["ignored"] }),
      }),
    ).toEqual({
      droppedLines: 0,
      lines: [],
      urlMatched: true,
      sessionMatched: true,
    });
  });

  it("does not guess a permission origin across work and consumer Teams", () => {
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.permissions({ allowMicrophone: true }),
    ).toBeUndefined();
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.permissionNotes({ allowMicrophone: true }),
    ).toContain("Teams media permissions are handled in the browser when prompted.");
  });

  it("parses leave steps and malformed status", () => {
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.parseLeaveResult({
        result: JSON.stringify({ departed: false, leaveAction: "confirm", urlMatched: true }),
      }),
    ).toEqual({ departed: false, leaveAction: "confirm", urlMatched: true });
    expect(() =>
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.parseStatus({ result: "not-json" }),
    ).toThrow("Microsoft Teams browser status JSON is malformed.");
  });
});
