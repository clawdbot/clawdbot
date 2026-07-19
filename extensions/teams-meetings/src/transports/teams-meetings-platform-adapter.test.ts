import { describe, expect, it, vi } from "vitest";
import {
  TEAMS_MEETINGS_PLATFORM_ADAPTER,
  isTeamsMeetingsRealtimeRouteReady,
} from "./teams-meetings-platform-adapter.js";
import {
  CONSUMER_URL,
  MEETING_STATE_KEY,
  consumerLightMeetingUrl,
  status,
  control,
  runStatusScript,
  runLeaveScript,
  type PageMedia,
} from "./teams-meetings-platform-adapter.test-helpers.js";

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

  it("retries transient in-call audio routing while Teams renders its media controls", () => {
    const pending = { ...status("teams-audio-choice-required"), inCall: true };

    expect(TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.shouldRetryJoinStatus?.(pending)).toBe(false);
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.shouldRetryJoinStatus?.({
        ...pending,
        audioInputRouted: true,
        audioOutputRouteRetryable: true,
      }),
    ).toBe(true);
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.shouldRetryJoinStatus?.({
        ...pending,
        audioOutputRouteError: "sink failed",
      }),
    ).toBe(false);
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.shouldRetryJoinStatus?.({
        ...pending,
        audioInputRouted: true,
        audioOutputRouteError: "play interrupted",
        audioOutputRouteRetryable: true,
      }),
    ).toBe(true);
  });

  it("retries transcribe join readiness until live captions are enabled", () => {
    const pending = {
      captionCaptureRequested: true,
      captioning: false,
      inCall: true,
    };

    expect(TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.shouldRetryJoinStatus?.(pending)).toBe(true);
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.shouldRetryJoinStatus?.({
        ...pending,
        captioning: true,
      }),
    ).toBe(false);
    expect(
      TEAMS_MEETINGS_PLATFORM_ADAPTER.browser.shouldRetryJoinStatus?.({
        ...pending,
        manualActionReason: "teams-session-conflict",
        manualActionRequired: true,
      }),
    ).toBe(false);
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

  it.each([
    ["camera", true, false],
    ["camera", false, true],
    ["microphone", true, false],
    ["microphone", false, true],
  ])("reads the live %s switch checked=%s", async (kind, checked, expectedOff) => {
    const target = control({ checked, label: kind === "camera" ? "Camera" : "Microphone" });
    const { result } = await runStatusScript({
      allowMicrophone: false,
      ...(kind === "camera" ? { camera: target } : { microphone: target }),
      readOnly: true,
    });
    expect(kind === "camera" ? result.cameraOff : result.micMuted).toBe(expectedOff);
  });

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

  it("allows non-adopting recovery to continue for the current page owner", async () => {
    const join = control({ label: "Join now" });
    const { result } = await runStatusScript({
      allowMicrophone: false,
      allowSessionAdoption: false,
      camera: control({ label: "Turn camera on", pressed: false }),
      join,
      microphone: control({ label: "Turn microphone on", pressed: false }),
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        sessionId: "session-1",
      },
    });

    expect(join.clicks).toBe(1);
    expect(result).toMatchObject({ clickedJoin: true, manualActionRequired: false });
  });

  it("preserves a newer owner for a different meeting identity", async () => {
    const priorMeeting = {
      identity: "teams-consumer:9326458712345:p:abc",
      sessionId: "consumer-session",
    };
    const { result, window } = await runStatusScript({
      allowMicrophone: false,
      allowSessionAdoption: true,
      currentUrl: CONSUMER_URL,
      priorMeeting,
    });

    expect(result).toMatchObject({ manualActionReason: "teams-session-conflict" });
    expect(window[MEETING_STATE_KEY]).toBe(priorMeeting);
  });

  it("does not mask an in-call session conflict with talkback audio readiness", async () => {
    const { result } = await runStatusScript({
      allowMicrophone: true,
      allowSessionAdoption: false,
      leave: control({ label: "Leave" }),
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        sessionId: "session-2",
      },
    });

    expect(result).toMatchObject({ manualActionReason: "teams-session-conflict" });
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

  it("verifies the consumer prejoin redirect from its encoded meeting coordinates", async () => {
    const { result, window } = await runStatusScript({
      allowMicrophone: false,
      currentUrl: consumerLightMeetingUrl("9326458712345", "abc"),
      meetingUrl: CONSUMER_URL,
    });

    expect(result.manualActionRequired).toBe(false);
    expect(window[MEETING_STATE_KEY]).toMatchObject({
      identity: "teams-consumer:9326458712345:p:abc",
      sessionId: "session-1",
    });
  });

  it("rejects consumer prejoin coordinates for a different meeting", async () => {
    const { result, window } = await runStatusScript({
      allowMicrophone: false,
      currentUrl: consumerLightMeetingUrl("1111111111111", "other"),
      meetingUrl: CONSUMER_URL,
    });

    expect(result).toMatchObject({
      inCall: false,
      manualActionReason: "teams-session-conflict",
    });
    expect(window).not.toHaveProperty(MEETING_STATE_KEY);
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

  it("retains prejoin identity for the configured in-call wait", async () => {
    const leave = control({ label: "Leave" });
    const admitted = await runStatusScript({
      allowMicrophone: false,
      currentUrl: "https://teams.microsoft.com/v2/",
      leave,
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        sessionId: "session-1",
        verifiedAt: Date.now() - 45_000,
      },
      waitForInCallMs: 60_000,
    });

    expect(admitted.result.inCall).toBe(true);
    expect(admitted.window[MEETING_STATE_KEY]).toMatchObject({
      identity: "teams-work:19:meeting_test@thread.v2",
      inCallControl: leave,
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

  it("does not trust a stale identity marker or post-call screen from another SPA call", () => {
    const staleLeave = control({ label: "Leave old call" });
    const currentLeave = control({ label: "Leave current call" });
    const bridge = { pause: vi.fn(), remove: vi.fn(), srcObject: {} };
    const { result, window } = runLeaveScript({
      currentUrl: "https://teams.microsoft.com/v2/",
      leave: currentLeave,
      postCall: control({ label: "Rejoin" }),
      priorAudioOutputs: [
        {
          bridge,
          sessionId: "session-1",
          source: { muted: true },
          sourceMuted: false,
        },
      ],
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        inCallControl: staleLeave,
        inCallUrl: "https://teams.microsoft.com/v2/",
      },
    });

    expect(result).toEqual({ departed: false, urlMatched: false });
    expect(currentLeave.clicks).toBe(0);
    expect(bridge.pause).not.toHaveBeenCalled();
    expect(window["__openclawTeamsAudioOutputs"]).toHaveLength(1);
  });

  it("does not use initiated-leave proof to act on a replacement SPA call", () => {
    const staleLeave = control({ label: "Leave old call" });
    const currentLeave = control({ label: "Leave current call" });
    const { result } = runLeaveScript({
      currentUrl: "https://teams.microsoft.com/v2/",
      leave: currentLeave,
      leaveInitiated: true,
      postCall: control({ label: "Rejoin" }),
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        inCallControl: staleLeave,
        inCallUrl: "https://teams.microsoft.com/v2/",
      },
    });

    expect(result).toEqual({ departed: false, urlMatched: false });
    expect(currentLeave.clicks).toBe(0);
  });

  it("does not leave a call owned by a newer OpenClaw session", () => {
    const leave = control({ label: "Leave" });
    const inCallUrl = "https://teams.microsoft.com/v2/";
    const { result } = runLeaveScript({
      currentUrl: inCallUrl,
      leave,
      meetingSessionId: "session-1",
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        inCallControl: leave,
        inCallUrl,
        sessionId: "session-2",
      },
    });

    expect(result).toEqual({
      departed: false,
      sessionConflict: true,
      sessionMatched: false,
      urlMatched: true,
    });
    expect(leave.clicks).toBe(0);
  });

  it("does not claim departure when page session ownership is missing", () => {
    const leave = control({ label: "Leave" });
    const { result } = runLeaveScript({
      leave,
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        sessionId: "",
      },
    });

    expect(result).toEqual({ departed: false, sessionMatched: false, urlMatched: true });
    expect(leave.clicks).toBe(0);
  });

  it("keeps the required ID-less leave callback functional for a matching meeting", () => {
    const leave = control({ label: "Leave" });
    const { result } = runLeaveScript({
      leave,
      meetingSessionId: "",
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        sessionId: "session-1",
      },
    });

    expect(result).toEqual({ departed: false, leaveAction: "leave", urlMatched: true });
    expect(leave.clicks).toBe(1);
  });

  it("accepts post-call proof after an initiated leave replaces the document", () => {
    const pending = runLeaveScript({
      currentUrl: "https://teams.microsoft.com/v2/",
      leaveInitiated: true,
      omitMeetingState: true,
    });
    expect(pending.result).toEqual({ departed: false, urlMatched: true });

    const { result } = runLeaveScript({
      leaveInitiated: true,
      omitMeetingState: true,
      postCall: control({ label: "Rejoin" }),
    });

    expect(result).toEqual({ departed: true, sessionMatched: true, urlMatched: true });
  });

  it("retires only the departing session's audio bridges", () => {
    const source = { currentSrc: "blob:https://teams.live.com/original", muted: true };
    const bridge = { pause: vi.fn(), remove: vi.fn(), srcObject: {} };
    const detachedSource = {
      isConnected: false,
      muted: true,
      pause: vi.fn(),
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
    };
    const detachedBridge = { pause: vi.fn(), remove: vi.fn(), srcObject: {} };
    const foreignBridge = { sessionId: "session-2" };
    const { result, window } = runLeaveScript({
      postCall: control({ label: "Rejoin" }),
      priorAudioOutputs: [
        {
          bridge,
          sessionId: "session-1",
          source,
          sourceMuted: false,
          sourceUrl: source.currentSrc,
        },
        {
          bridge: detachedBridge,
          sessionId: "session-1",
          source: detachedSource,
          sourceMuted: false,
          stream: detachedSource.srcObject,
        },
        foreignBridge,
      ],
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        sessionId: "session-1",
      },
    });

    expect(result).toEqual({ departed: true, sessionMatched: true, urlMatched: true });
    expect(source.muted).toBe(false);
    expect(bridge.pause).toHaveBeenCalledOnce();
    expect(bridge.remove).toHaveBeenCalledOnce();
    expect(bridge.srcObject).toBeNull();
    expect(detachedSource.muted).toBe(true);
    expect(detachedSource.pause).toHaveBeenCalledOnce();
    expect(detachedSource.srcObject).toBeNull();
    expect(detachedBridge.remove).toHaveBeenCalledOnce();
    expect(window["__openclawTeamsAudioOutputs"]).toEqual([foreignBridge]);
  });

  it("does not unmute a replacement stream during leave cleanup", () => {
    const bridgedStream = { getAudioTracks: () => [{ readyState: "live" }] };
    const replacementStream = { getAudioTracks: () => [{ readyState: "live" }] };
    const source = { muted: true, srcObject: replacementStream };
    const bridge = { pause: vi.fn(), remove: vi.fn(), srcObject: bridgedStream };
    const { result } = runLeaveScript({
      postCall: control({ label: "Rejoin" }),
      priorAudioOutputs: [
        {
          bridge,
          sessionId: "session-1",
          source,
          sourceMuted: false,
          stream: bridgedStream,
        },
      ],
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        sessionId: "session-1",
      },
    });

    expect(result).toEqual({ departed: true, sessionMatched: true, urlMatched: true });
    expect(source.muted).toBe(true);
    expect(source.srcObject).toBe(replacementStream);
    expect(bridge.pause).toHaveBeenCalledOnce();
    expect(bridge.remove).toHaveBeenCalledOnce();
  });

  it("does not unmute a reused URL-backed element during leave cleanup", () => {
    const source = { currentSrc: "blob:https://teams.live.com/replacement", muted: true };
    const bridge = { pause: vi.fn(), remove: vi.fn(), srcObject: null };
    const { result } = runLeaveScript({
      postCall: control({ label: "Rejoin" }),
      priorAudioOutputs: [
        {
          bridge,
          sessionId: "session-1",
          source,
          sourceMuted: false,
          sourceUrl: "blob:https://teams.live.com/original",
        },
      ],
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        sessionId: "session-1",
      },
    });

    expect(result).toEqual({ departed: true, sessionMatched: true, urlMatched: true });
    expect(source.muted).toBe(true);
    expect(bridge.pause).toHaveBeenCalledOnce();
    expect(bridge.remove).toHaveBeenCalledOnce();
  });

  it("restores pending and legacy sources-array entries during leave cleanup", () => {
    const pending = { muted: true };
    const legacy = { currentSrc: "blob:https://teams.live.com/legacy", muted: true };
    const { result } = runLeaveScript({
      postCall: control({ label: "Rejoin" }),
      priorAudioOutputs: [
        {
          sessionId: "session-1",
          sources: [
            { element: pending, muted: false, pending: true },
            { element: legacy, muted: false },
          ],
        },
      ],
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        sessionId: "session-1",
      },
    });

    expect(result).toEqual({ departed: true, sessionMatched: true, urlMatched: true });
    expect(pending.muted).toBe(true);
    expect(legacy.muted).toBe(true);
  });

  it("retires the page-owned audio bridge from the required URL-only leave callback", () => {
    const stream = { getAudioTracks: () => [{ readyState: "live" }] };
    const source = { muted: true, srcObject: stream };
    const bridge = { pause: vi.fn(), remove: vi.fn(), srcObject: stream };
    const { result, window } = runLeaveScript({
      meetingSessionId: "",
      postCall: control({ label: "Rejoin" }),
      priorAudioOutputs: [
        {
          bridge,
          sessionId: "session-1",
          source,
          sourceMuted: false,
          stream,
        },
      ],
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        sessionId: "session-1",
      },
    });

    expect(result).toEqual({ departed: true, sessionMatched: true, urlMatched: true });
    expect(source.muted).toBe(false);
    expect(bridge.pause).toHaveBeenCalledOnce();
    expect(bridge.remove).toHaveBeenCalledOnce();
    expect(window).not.toHaveProperty("__openclawTeamsAudioOutputs");
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

  it("does not report a prompt that it just dismissed while Teams removes the DOM", async () => {
    const continueWithoutDevices = control({ label: "Continue without audio or video" });
    const { result } = await runStatusScript({
      allowMicrophone: false,
      continueWithoutDevices,
      permissionPrompt: control({ label: "Device permission prompt" }),
    });

    expect(result).toMatchObject({ manualActionRequired: false });
    expect(continueWithoutDevices.clicks).toBe(1);
  });

  it("does not treat the live camera troubleshooting banner as a media permission block", async () => {
    const join = control({ label: "Join now" });
    const { result } = await runStatusScript({
      allowMicrophone: true,
      bodyText: "Your camera is turned off\nGo to your device settings to troubleshoot",
      camera: control({ checked: false, label: "Camera" }),
      devices: [{ deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" }],
      join,
      microphone: control({ checked: true, label: "Microphone" }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
    });

    expect(result).toMatchObject({ clickedJoin: true, manualActionRequired: false });
    expect(join.clicks).toBe(1);
  });

  it("does not treat the camera-only no-devices warning as a microphone block", async () => {
    const join = control({ label: "Join now" });
    const { result } = await runStatusScript({
      allowMicrophone: true,
      camera: control({ checked: false, label: "Camera" }),
      continueWithoutDevices: control({ label: "Continue without audio or video" }),
      devices: [{ deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" }],
      join,
      microphone: control({ checked: true, label: "Microphone" }),
      microphoneDevice: control({ label: "BlackHole 2ch (Virtual)" }),
      microphonePermissionState: "granted",
      permissionPrompt: control({ label: "Camera permission warning" }),
    });

    expect(result).toMatchObject({ clickedJoin: true, manualActionRequired: false });
    expect(join.clicks).toBe(1);
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
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
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

  it("reports the prepared session input during read-only status inspection", async () => {
    const media: PageMedia = { sinkId: "blackhole-output", async setSinkId() {} };
    const { result } = await runStatusScript({
      allowMicrophone: true,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [media],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      priorMeeting: {
        audioInputDeviceId: "blackhole-input",
        identity: "teams-work:19:meeting_test@thread.v2",
        sessionId: "session-1",
      },
      readOnly: true,
    });

    expect(result).toMatchObject({
      audioInputRouted: true,
      audioOutputRouted: true,
      manualActionRequired: false,
    });
  });

  it("routes a directly playable media element before its MediaStream is attached", async () => {
    const media: PageMedia = {
      sinkId: "",
      async setSinkId(value) {
        media.sinkId = value;
      },
    };
    const { result } = await runStatusScript({
      allowMicrophone: true,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [media],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
    });

    expect(result.audioOutputRouted).toBe(true);
    expect(media.sinkId).toBe("blackhole-output");
  });

  it("reopens in-call audio options to reverify the BlackHole input", async () => {
    const deviceSettings = control({ label: "Open audio options" });
    const { result } = await runStatusScript({
      allowMicrophone: true,
      devices: [{ deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" }],
      deviceSettings,
      leave: control({ label: "Leave" }),
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDeviceAfterSettings: control({ label: "BlackHole 2ch (Virtual)" }),
      priorMeeting: {
        audioInputDeviceId: "blackhole-input",
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    });

    expect(result).toMatchObject({
      audioInputRouted: true,
      inCall: true,
      micMuted: false,
    });
    expect(deviceSettings.clicks).toBe(1);
  });

  it("reads the selected in-call microphone from the live consumer listbox", async () => {
    const deviceSettings = control({ label: "Open audio options" });
    const selected = control({ label: "BlackHole 2ch (Virtual)" });
    selected.getAttribute = (name) =>
      name === "aria-selected" ? "true" : name === "aria-label" ? "BlackHole 2ch (Virtual)" : null;
    const microphoneMenu = control({ label: "Microphone devices" });
    microphoneMenu.querySelector = (selector) =>
      selector?.includes('aria-selected="true"') ? selected : undefined;
    const { result } = await runStatusScript({
      allowMicrophone: true,
      devices: [{ deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" }],
      deviceSettings,
      leave: control({ label: "Leave" }),
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDeviceMenuAfterSettings: microphoneMenu,
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
    });

    expect(result).toMatchObject({ audioInputRouted: true, inCall: true, micMuted: false });
    expect(deviceSettings.clicks).toBe(1);
  });

  it("does not choose the audio-less fallback in talkback modes", async () => {
    const continueWithoutDevices = control({
      label: "Continue without audio or video",
    });
    await runStatusScript({
      allowMicrophone: true,
      continueWithoutDevices,
      microphone: control({ label: "Turn microphone on", pressed: false }),
    });
    expect(continueWithoutDevices.clicks).toBe(0);

    await runStatusScript({
      allowMicrophone: false,
      continueWithoutDevices,
      microphone: control({ label: "Turn microphone on", pressed: false }),
    });
    expect(continueWithoutDevices.clicks).toBe(1);

    await runStatusScript({
      allowMicrophone: false,
      autoJoin: false,
      continueWithoutDevices,
      microphone: control({ label: "Turn microphone on", pressed: false }),
    });
    expect(continueWithoutDevices.clicks).toBe(1);
  });

  it("bridges a live Teams MediaStream when its unloaded audio element rejects setSinkId", async () => {
    const source: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
    const routingOrder: string[] = [];
    const bridge: PageMedia = {
      isConnected: false,
      sinkId: "",
      async play() {
        expect(source.muted).toBe(true);
        expect(bridge.sinkId).toBe("blackhole-output");
        routingOrder.push("play");
      },
      async setSinkId(value) {
        expect(source.muted).toBe(true);
        routingOrder.push("sink");
        bridge.sinkId = value;
      },
    };
    const { result, window } = await runStatusScript({
      allowMicrophone: true,
      bridgeMedia: bridge,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [source],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: {
        audioInputDeviceId: "blackhole-input",
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    });

    expect(bridge.autoplay).toBe(false);
    expect(routingOrder).toEqual(["sink", "play"]);
    expect(result).toMatchObject({
      audioInputRouted: true,
      audioOutputRouted: true,
      manualActionRequired: false,
    });
    expect(bridge.sinkId).toBe("blackhole-output");
    expect(source.muted).toBe(true);
    expect(window).toHaveProperty("__openclawTeamsAudioOutputs");
    expect((window["__openclawTeamsAudioOutputs"] as Array<{ bridge: PageMedia }>)[0]?.bridge).toBe(
      bridge,
    );

    const repeated = await runStatusScript({
      allowMicrophone: true,
      bridgeMedia: bridge,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [source, bridge],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorAudioOutputs: window["__openclawTeamsAudioOutputs"] as unknown[],
      priorMeeting: window[MEETING_STATE_KEY] as Record<string, unknown>,
    });
    expect(repeated.result.audioOutputRouted).toBe(true);
    expect(
      (repeated.window["__openclawTeamsAudioOutputs"] as Array<{ bridge: PageMedia }>)[0]?.bridge,
    ).toBe(bridge);
  });
});
