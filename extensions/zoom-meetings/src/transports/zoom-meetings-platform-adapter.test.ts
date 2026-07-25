import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { zoomMeetingLeaveScript, zoomMeetingStatusScript } from "./zoom-meetings-page-scripts.js";
import {
  ZOOM_MEETINGS_PLATFORM_ADAPTER,
  isZoomMeetingsRealtimeRouteReady,
} from "./zoom-meetings-platform-adapter.js";

const URL = "https://acme.zoom.us/j/12345678901?pwd=abc";

function pageControl(label: string) {
  const click = vi.fn();
  const control = {
    disabled: false,
    isConnected: true,
    textContent: label,
    click,
    closest: () => control,
    getAttribute: (name: string) => (name === "aria-label" ? label : null),
    matches: (selector: string) => selector === "button",
    querySelector: () => undefined,
    querySelectorAll: () => [],
  };
  return control;
}

function guestInput(value: string) {
  return {
    ...pageControl("Guest name"),
    dispatchEvent: vi.fn(),
    focus: vi.fn(),
    placeholder: "Enter your name",
    value,
  };
}

function statusDocument(params: {
  bodyText: string;
  camera?: ReturnType<typeof pageControl>;
  challenge?: ReturnType<typeof pageControl>;
  devicePrompt?: ReturnType<typeof pageControl>;
  guest?: ReturnType<typeof guestInput>;
  join?: ReturnType<typeof pageControl>;
  kind?: string;
  leave?: ReturnType<typeof pageControl>;
  microphone?: ReturnType<typeof pageControl>;
}) {
  const controls = [
    params.camera,
    params.challenge,
    params.devicePrompt,
    params.join,
    params.leave,
    params.microphone,
  ].filter((control): control is ReturnType<typeof pageControl> => Boolean(control));
  return {
    body: { appendChild: () => {}, textContent: params.bodyText },
    defaultView: {
      Event: globalThis.Event,
      HTMLInputElement: function HTMLInputElement() {
        return undefined;
      },
      MutationObserver: function MutationObserver() {
        return undefined;
      },
    },
    title: "Zoom",
    getElementById: () => undefined,
    querySelector(selector: string) {
      if (selector.includes("preview-join-button")) {
        return params.join;
      }
      if (selector.includes("input-for-name")) {
        return params.guest;
      }
      if (selector.includes('aria-label="Leave"')) {
        return params.leave;
      }
      if (selector.includes("preview-video-control-button") || selector.includes("send-video")) {
        return params.camera;
      }
      if (
        selector.includes("preview-audio-control-button") ||
        selector.includes("mute my microphone") ||
        selector.includes("unmute my microphone")
      ) {
        return params.microphone;
      }
      if (
        params.kind === "passcode" &&
        (selector.includes("password") || selector.includes("passcode"))
      ) {
        return params.challenge;
      }
      if (
        params.kind === "captcha" &&
        (selector.includes("recaptcha") ||
          selector.includes("captcha") ||
          selector.includes("data-sitekey"))
      ) {
        return params.challenge;
      }
      return undefined;
    },
    querySelectorAll: (selector: string) =>
      selector === "button" || selector.includes('[role="button"]') ? controls : [],
  };
}

async function runStatusFixture(params: {
  allowMicrophone?: boolean;
  currentUrl?: string;
  document: ReturnType<typeof statusDocument>;
  navigator?: Record<string, unknown>;
  readOnly?: boolean;
  window?: Record<string, unknown>;
}) {
  const result = await runInNewContext(
    `(${zoomMeetingStatusScript({
      allowMicrophone: params.allowMicrophone ?? false,
      allowSessionAdoption: true,
      autoJoin: true,
      captureCaptions: false,
      guestName: "OpenClaw Agent",
      meetingSessionId: "session-1",
      meetingUrl: URL,
      readOnly: params.readOnly,
      waitForInCallMs: 60_000,
    })})()`,
    {
      URL: globalThis.URL,
      crypto: { randomUUID: () => "caption-id" },
      document: params.document,
      location: new globalThis.URL(params.currentUrl ?? URL),
      navigator: params.navigator ?? {},
      setTimeout,
      clearTimeout,
      window: params.window ?? {},
    },
  );
  return JSON.parse(result) as Record<string, unknown>;
}

function status(reason: string) {
  const health = ZOOM_MEETINGS_PLATFORM_ADAPTER.browser.parseStatus({
    result: JSON.stringify({
      inCall: false,
      manualActionRequired: true,
      manualActionReason: reason,
      manualActionMessage: "manual action",
      url: URL,
    }),
  });
  if (!health) {
    throw new Error("expected parsed health");
  }
  return health;
}

describe("Zoom meeting platform adapter", () => {
  it("preserves host-ended state from the browser status", () => {
    expect(
      ZOOM_MEETINGS_PLATFORM_ADAPTER.browser.parseStatus({
        result: JSON.stringify({ inCall: false, meetingEnded: true }),
      }),
    ).toMatchObject({ inCall: false, meetingEnded: true });
  });

  it.each([
    ["zoom-login-required", "login-required"],
    ["zoom-admission-required", "admission-required"],
    ["zoom-passcode-required", "admission-required"],
    ["zoom-captcha-required", "admission-required"],
    ["zoom-permission-required", "permission-required"],
    ["zoom-audio-choice-required", "audio-choice-required"],
    ["zoom-session-conflict", "session-conflict"],
    ["browser-control-unavailable", "browser-control-unavailable"],
  ])("classifies %s as %s", (reason, category) => {
    expect(ZOOM_MEETINGS_PLATFORM_ADAPTER.browser.classifyManualAction(status(reason))).toEqual({
      category,
      reason,
      message: "manual action",
    });
  });

  it("grants microphone and optional output routing on the Zoom Web App origin", () => {
    expect(
      ZOOM_MEETINGS_PLATFORM_ADAPTER.browser.permissions({
        allowMicrophone: true,
        meetingUrl: URL,
      }),
    ).toEqual({
      origin: "https://app.zoom.us",
      permissions: ["audioCapture"],
      optionalPermissions: ["speakerSelection"],
    });
    expect(
      ZOOM_MEETINGS_PLATFORM_ADAPTER.browser.permissions({
        allowMicrophone: false,
        meetingUrl: URL,
      }),
    ).toBeUndefined();
  });

  it("builds the live-validated guest, iframe, audio, leave, and caption controls", () => {
    const script = zoomMeetingStatusScript({
      allowMicrophone: true,
      allowSessionAdoption: true,
      autoJoin: true,
      captureCaptions: true,
      guestName: "OpenClaw Agent",
      meetingSessionId: "session-1",
      meetingUrl: URL,
      waitForInCallMs: 60_000,
    });

    expect(script).toContain("#webclient");
    expect(script).toContain("input#input-for-name");
    expect(script).toContain("#preview-audio-control-button");
    expect(script).toContain("#preview-video-control-button");
    expect(script).toContain('aria-label=\\\"Leave\\\"');
    expect(script).toContain("live-transcription-subtitle__box");
    expect(script).toContain("live-transcription-subtitle__item");
    expect(script).toContain("zmu-data-selector-item__icon");
    expect(script).toContain("audio-option-menu__pop-menu");
    expect(script).toContain("videooff");
    expect(script).toContain("my )?(?:microphone|mic)");
    expect(script).toContain("join from browser");
    expect(script).toContain("host will let you in soon");
    expect(script).toContain("setSinkId");
    expect(script).toContain("BlackHole");
  });

  it("enables caption snapshots for durable notes in every mode", () => {
    expect(ZOOM_MEETINGS_PLATFORM_ADAPTER.browser.captions.enabled("transcribe")).toBe(true);
    expect(ZOOM_MEETINGS_PLATFORM_ADAPTER.browser.captions.enabled("agent")).toBe(true);
    expect(ZOOM_MEETINGS_PLATFORM_ADAPTER.browser.captions.enabled("bidi")).toBe(true);
  });

  it("requires verified bidirectional audio before realtime startup", () => {
    expect(
      isZoomMeetingsRealtimeRouteReady("agent", {
        inCall: true,
        micMuted: false,
        audioInputRouted: true,
        audioOutputRouted: true,
      }),
    ).toBe(true);
    expect(
      isZoomMeetingsRealtimeRouteReady("agent", {
        inCall: true,
        micMuted: true,
        audioInputRouted: true,
        audioOutputRouted: true,
      }),
    ).toBe(false);
  });

  it("recognizes the Zoom Web App home redirect as completed leave", () => {
    const state = { identity: "zoom:12345678901", sessionId: "session-1" };
    const document = {
      body: { textContent: "Join Meeting" },
      querySelector: () => undefined,
      querySelectorAll: () => [],
    };
    const result = runInNewContext(
      `(${zoomMeetingLeaveScript({
        leaveInitiated: true,
        meetingSessionId: "session-1",
        meetingUrl: URL,
      })})()`,
      {
        URL: globalThis.URL,
        document,
        location: new globalThis.URL("https://app.zoom.us/wc?ref_from=waffle_zwa"),
        window: { __openclawZoomMeeting: state },
      },
    );

    expect(JSON.parse(result)).toEqual({
      departed: true,
      sessionMatched: true,
      urlMatched: true,
    });
  });

  it("does not treat a live Web App home page or meeting text as post-call", () => {
    const leave = pageControl("Leave");
    const document = {
      body: { textContent: "Someone said the meeting has ended" },
      querySelector: (selector: string) =>
        selector.includes('aria-label="Leave"') ? leave : undefined,
      querySelectorAll: (selector: string) =>
        selector === "button"
          ? [leave]
          : selector.includes("main")
            ? [{ textContent: "Someone said the meeting has ended" }]
            : [],
    };
    const result = runInNewContext(
      `(${zoomMeetingLeaveScript({
        leaveInitiated: false,
        meetingSessionId: "session-1",
        meetingUrl: URL,
      })})()`,
      {
        URL: globalThis.URL,
        document,
        location: new globalThis.URL("https://app.zoom.us/wc"),
        window: {
          __openclawZoomMeeting: {
            identity: "zoom:12345678901",
            inCallControl: leave,
            inCallUrl: "https://app.zoom.us/wc",
            sessionId: "session-1",
          },
        },
      },
    );

    expect(JSON.parse(result)).toMatchObject({ departed: false, leaveAction: "leave" });
    expect(leave.click).toHaveBeenCalledOnce();
  });

  it("re-adopts a verified meeting URL after a full document reload before leaving", () => {
    const leave = {
      disabled: false,
      isConnected: true,
      textContent: "Leave",
      click: vi.fn(),
      closest: () => leave,
      getAttribute: (name: string) => (name === "aria-label" ? "Leave" : null),
      matches: (selector: string) => selector === "button",
      querySelector: () => undefined,
    };
    const document = {
      body: { textContent: "" },
      querySelector: (selector: string) =>
        selector.includes('aria-label="Leave"') ? leave : undefined,
      querySelectorAll: (selector: string) => (selector === "button" ? [leave] : []),
    };
    const window: Record<string, unknown> = {};
    const result = runInNewContext(
      `(${zoomMeetingLeaveScript({
        leaveInitiated: false,
        meetingSessionId: "session-1",
        meetingUrl: URL,
      })})()`,
      {
        URL: globalThis.URL,
        document,
        location: new globalThis.URL(URL),
        window,
      },
    );

    expect(JSON.parse(result)).toMatchObject({ leaveAction: "leave", urlMatched: true });
    expect(leave.click).toHaveBeenCalledOnce();
    expect(window).toMatchObject({
      __openclawZoomMeeting: { identity: "zoom:12345678901", sessionId: "session-1" },
    });
  });

  it.each([
    {
      bodyText: "Enter meeting passcode",
      kind: "passcode",
      reason: "zoom-passcode-required",
    },
    {
      bodyText: "Security check",
      kind: "captcha",
      reason: "zoom-captcha-required",
    },
  ])("reports a $kind challenge before camera gating", async ({ bodyText, kind, reason }) => {
    const join = pageControl("Join");
    const challenge = pageControl(kind === "passcode" ? "Meeting passcode" : "CAPTCHA");
    const document = statusDocument({ bodyText, challenge, join, kind });
    const result = await runStatusFixture({ document });

    expect(result).toMatchObject({
      clickedJoin: false,
      manualActionReason: reason,
      manualActionRequired: true,
    });
    expect(join.click).not.toHaveBeenCalled();
  });

  it("replaces Zoom's remembered guest name before joining", async () => {
    const guest = guestInput("Remembered Human");
    const join = pageControl("Join");
    const result = await runStatusFixture({
      document: statusDocument({
        bodyText: "",
        camera: pageControl("Start Video"),
        guest,
        join,
        microphone: pageControl("Unmute my microphone"),
      }),
    });

    expect(guest.value).toBe("OpenClaw Agent");
    expect(guest.dispatchEvent).toHaveBeenCalledTimes(2);
    expect(join.click).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ clickedJoin: true, manualActionRequired: false });
  });

  it("persists Zoom's confirmed no-device state for observe-only joins", async () => {
    const window: Record<string, unknown> = {};
    const devicePrompt = pageControl("Continue without audio or video");
    devicePrompt.click.mockImplementation(() => {
      devicePrompt.disabled = true;
    });
    const first = await runStatusFixture({
      document: statusDocument({
        bodyText: "",
        devicePrompt,
        join: pageControl("Join"),
      }),
      window,
    });
    const second = await runStatusFixture({
      document: statusDocument({ bodyText: "", join: pageControl("Join") }),
      readOnly: true,
      window,
    });

    expect(devicePrompt.click).toHaveBeenCalled();
    expect(first.manualActionReason).toBeUndefined();
    expect(first).toMatchObject({
      cameraOff: true,
      clickedJoin: true,
      manualActionRequired: false,
      micMuted: true,
    });
    expect(second).toMatchObject({
      cameraOff: true,
      manualActionRequired: false,
      micMuted: true,
    });
    expect(window["__openclawZoomMeeting"]).toMatchObject({ devicesDisabled: true });
  });

  it("re-mutes an observe-only session after admission", async () => {
    let microphoneLabel = "Mute my microphone";
    const microphone = pageControl(microphoneLabel);
    microphone.getAttribute = (name: string) => (name === "aria-label" ? microphoneLabel : null);
    microphone.click.mockImplementation(() => {
      microphoneLabel = "Unmute my microphone";
      microphone.textContent = microphoneLabel;
    });
    const result = await runStatusFixture({
      document: statusDocument({
        bodyText: "",
        camera: pageControl("Start Video"),
        leave: pageControl("Leave"),
        microphone,
      }),
    });

    expect(result).toMatchObject({ inCall: true, micMuted: true, manualActionRequired: false });
    expect(microphone.click).toHaveBeenCalledOnce();
  });

  it("fails closed when an in-call observe-only microphone cannot be verified", async () => {
    const result = await runStatusFixture({
      document: statusDocument({
        bodyText: "",
        camera: pageControl("Start Video"),
        leave: pageControl("Leave"),
      }),
    });

    expect(result).toMatchObject({
      inCall: true,
      manualActionReason: "zoom-microphone-required",
      manualActionRequired: true,
    });
  });

  it("turns off an adopted in-call camera", async () => {
    let cameraLabel = "Stop Video";
    const camera = pageControl(cameraLabel);
    camera.getAttribute = (name: string) => (name === "aria-label" ? cameraLabel : null);
    camera.click.mockImplementation(() => {
      cameraLabel = "Start Video";
      camera.textContent = cameraLabel;
    });
    const result = await runStatusFixture({
      document: statusDocument({
        bodyText: "",
        camera,
        leave: pageControl("Leave"),
        microphone: pageControl("Unmute my microphone"),
      }),
    });

    expect(result).toMatchObject({ cameraOff: true, inCall: true, manualActionRequired: false });
    expect(camera.click).toHaveBeenCalledOnce();
  });

  it("fails closed when an adopted in-call camera cannot be verified", async () => {
    const result = await runStatusFixture({
      document: statusDocument({
        bodyText: "",
        leave: pageControl("Leave"),
        microphone: pageControl("Unmute my microphone"),
      }),
    });

    expect(result).toMatchObject({
      inCall: true,
      manualActionReason: "zoom-camera-required",
      manualActionRequired: true,
    });
  });

  it("marks a previously verified call ended after its control stays gone", async () => {
    const result = await runStatusFixture({
      currentUrl: "https://app.zoom.us/wc",
      document: statusDocument({ bodyText: "" }),
      window: {
        __openclawZoomMeeting: {
          identity: "zoom:12345678901",
          inCallControl: { isConnected: false },
          inCallControlLostAt: Date.now() - 6_000,
          inCallUrl: "https://app.zoom.us/wc/12345678901/join",
          sessionId: "session-1",
          verifiedAt: Date.now() - 6_000,
        },
      },
    });

    expect(result).toMatchObject({ inCall: false, meetingEnded: true });
  });

  it("re-adopts a replacement Leave control after a late Zoom rerender", async () => {
    const result = await runStatusFixture({
      currentUrl: "https://app.zoom.us/wc/12345678901/join",
      document: statusDocument({
        bodyText: "",
        camera: pageControl("Start Video"),
        leave: pageControl("Leave"),
        microphone: pageControl("Unmute my microphone"),
      }),
      readOnly: true,
      window: {
        __openclawZoomMeeting: {
          identity: "zoom:12345678901",
          inCallControl: { isConnected: false },
          inCallUrl: "https://app.zoom.us/wc/12345678901/join",
          sessionId: "session-1",
          verifiedAt: Date.now() - 60_000,
        },
      },
    });

    expect(result).toMatchObject({ inCall: true, meetingEnded: false });
  });

  it("does not trust a cached BlackHole device after Zoom hides its current selection", async () => {
    const meetingState = {
      audioInputDeviceId: "blackhole-device",
      identity: "zoom:12345678901",
      sessionId: "session-1",
    };
    const result = await runStatusFixture({
      allowMicrophone: true,
      document: statusDocument({
        bodyText: "",
        camera: pageControl("Start Video"),
        leave: pageControl("Leave"),
        microphone: pageControl("Mute my microphone"),
      }),
      navigator: {
        mediaDevices: {
          enumerateDevices: vi.fn(async () => [
            { deviceId: "blackhole-device", kind: "audioinput", label: "BlackHole 2ch" },
          ]),
        },
      },
      readOnly: true,
      window: { __openclawZoomMeeting: meetingState },
    });

    expect(result).toMatchObject({
      audioInputRouted: false,
      manualActionReason: "zoom-audio-choice-required",
      manualActionRequired: true,
    });
    expect(meetingState).not.toHaveProperty("audioInputDeviceId");
  });

  it("retains meeting ownership through an unbounded lobby wait", async () => {
    const window: Record<string, unknown> = {};
    const waiting = await runStatusFixture({
      document: statusDocument({ bodyText: "The host will let you in soon" }),
      window,
    });
    const marker = window["__openclawZoomMeeting"] as Record<string, unknown>;
    marker.verifiedAt = 0;

    const admitted = await runStatusFixture({
      currentUrl: "https://app.zoom.us/wc",
      document: statusDocument({
        bodyText: "",
        leave: pageControl("Leave"),
        microphone: pageControl("Unmute my microphone"),
      }),
      window,
    });

    expect(waiting).toMatchObject({
      lobbyWaiting: true,
      manualActionReason: "zoom-admission-required",
    });
    expect(admitted).toMatchObject({ inCall: true, micMuted: true });
    expect(window["__openclawZoomMeeting"]).toMatchObject({
      awaitingAdmission: false,
      identity: "zoom:12345678901",
      sessionId: "session-1",
    });
  });
});
