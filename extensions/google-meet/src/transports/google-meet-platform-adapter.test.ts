import { runInNewContext } from "node:vm";
import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { describe, expect, it, vi } from "vitest";
import { meetStatusScript } from "./google-meet-page-scripts.js";
import { GOOGLE_MEET_PLATFORM_ADAPTER } from "./google-meet-platform-adapter.js";

const MEETING_URL = "https://meet.google.com/abc-defg-hij";

function pageNode(label: string) {
  return {
    disabled: false,
    textContent: label,
    click: vi.fn(),
    getAttribute: (name: string) => (name === "aria-label" ? label : null),
  };
}

function microphoneSelect(labels: string[]) {
  const options = labels.map((label, index) => ({
    label,
    selected: index === 0,
    textContent: label,
    value: `device-${index}`,
  }));
  let value = options[0]?.value;
  return {
    dispatchEvent: vi.fn(),
    get options() {
      return options;
    },
    get selectedOptions() {
      return options.filter((option) => option.selected);
    },
    getAttribute: (name: string) => (name === "aria-label" ? "Microphone" : null),
    textContent: "",
    get value() {
      return value;
    },
    set value(next: string | undefined) {
      value = next;
      for (const option of options) {
        option.selected = option.value === next;
      }
    },
  };
}

async function runAudioStatus(
  label: string,
  selectLabels = ["MacBook Microphone", label],
  initialMicrophoneLabel = "Turn on microphone",
) {
  let microphoneLabel = initialMicrophoneLabel;
  const microphone = pageNode("");
  microphone.getAttribute = (name: string) => (name === "aria-label" ? microphoneLabel : null);
  microphone.click.mockImplementation(() => {
    microphoneLabel = /turn on microphone/i.test(microphoneLabel)
      ? "Turn off microphone"
      : "Turn on microphone";
  });
  const leave = pageNode("Leave call");
  const select = microphoneSelect(selectLabels);
  const media = {
    sinkId: "",
    setSinkId: vi.fn(async (value: string) => {
      media.sinkId = value;
    }),
  };
  const buttons = [microphone, leave];
  const document = {
    body: { textContent: "" },
    title: "Meet",
    querySelector(selector: string) {
      if (selector.includes("select") && selector.includes("microphone")) {
        return select;
      }
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === "button") {
        return buttons;
      }
      if (selector === "input") {
        return [];
      }
      if (selector === "audio, video") {
        return [media];
      }
      if (selector.includes("button") || selector.includes('[role="')) {
        return buttons;
      }
      return [];
    },
  };
  const outputLabel = label.includes("OpenClaw") ? "OpenClaw Meeting Audio" : label;
  const result = await runInNewContext(
    `(${meetStatusScript({
      allowMicrophone: true,
      autoJoin: false,
      captureCaptions: false,
      guestName: "OpenClaw Agent",
    })})()`,
    {
      Event: globalThis.Event,
      JSON,
      String,
      document,
      location: { href: MEETING_URL, hostname: "meet.google.com" },
      navigator: {
        mediaDevices: {
          enumerateDevices: async () => [
            { deviceId: "input-1", kind: "audioinput", label },
            { deviceId: "output-1", kind: "audiooutput", label: outputLabel },
          ],
        },
      },
      setTimeout: (callback: () => void) => {
        callback();
        return 1;
      },
      clearTimeout,
      window: {},
    },
  );
  return {
    health: JSON.parse(result) as Record<string, unknown>,
    media,
    microphone,
    select,
  };
}

describe("GOOGLE_MEET_PLATFORM_ADAPTER captions", () => {
  it("enables caption capture for durable notes in every browser mode", () => {
    expect(GOOGLE_MEET_PLATFORM_ADAPTER.browser.captions.enabled("agent")).toBe(true);
    expect(GOOGLE_MEET_PLATFORM_ADAPTER.browser.captions.enabled("bidi")).toBe(true);
    expect(GOOGLE_MEET_PLATFORM_ADAPTER.browser.captions.enabled("transcribe")).toBe(true);
  });
});

describe("GOOGLE_MEET_PLATFORM_ADAPTER audio routing", () => {
  it.each(["BlackHole 2ch", "Monitor of OpenClaw Meeting Audio"])(
    "selects and verifies %s for bidirectional Meet audio",
    async (label) => {
      const { health, media, microphone, select } = await runAudioStatus(label);

      expect(health).toMatchObject({
        audioInputRouted: true,
        audioInputDeviceLabel: label,
        audioOutputRouted: true,
        audioOutputDeviceLabel: label.includes("OpenClaw") ? "OpenClaw Meeting Audio" : label,
        micMuted: false,
      });
      expect(health.manualAction).toBeUndefined();
      expect(select.dispatchEvent).toHaveBeenCalledTimes(2);
      expect(microphone.click).toHaveBeenCalledOnce();
      expect(media.setSinkId).toHaveBeenCalledWith("output-1");
    },
  );

  it("parses input-route health and retries until both routes are ready", () => {
    const pending = GOOGLE_MEET_PLATFORM_ADAPTER.browser.parseStatus({
      result: JSON.stringify({
        inCall: true,
        micMuted: false,
        audioInputRouted: true,
        audioInputDeviceLabel: "OpenClaw Meeting Audio",
        audioOutputRouted: false,
        manualAction: {
          reason: "meet-audio-choice-required",
          message: "Select the virtual speaker",
        },
      }),
    });

    expect(pending).toMatchObject({
      audioInputRouted: true,
      audioInputDeviceLabel: "OpenClaw Meeting Audio",
      audioOutputRouted: false,
    });
    if (!pending) {
      throw new Error("expected parsed Google Meet browser health");
    }
    expect(GOOGLE_MEET_PLATFORM_ADAPTER.browser.shouldRetryJoinStatus?.(pending)).toBe(true);
    expect(
      MeetingPlatformAdapter.isRealtimeRouteReady("agent", {
        ...pending,
        audioOutputRouted: true,
        manualAction: undefined,
      }),
    ).toBe(true);
    expect(MeetingPlatformAdapter.isRealtimeRouteReady("agent", pending)).toBe(false);
  });

  it("keeps Meet muted and reports manual action when input selection cannot be verified", async () => {
    const { health, microphone } = await runAudioStatus(
      "OpenClaw Meeting Audio",
      ["MacBook Microphone"],
      "Turn off microphone",
    );

    expect(health).toMatchObject({
      audioInputRouted: false,
      audioInputRouteError: "Meet did not confirm OpenClaw Meeting Audio as its microphone.",
      audioOutputRouted: true,
      micMuted: true,
      manualAction: { reason: "meet-audio-choice-required" },
    });
    expect(microphone.click).toHaveBeenCalledOnce();
    expect(MeetingPlatformAdapter.isRealtimeRouteReady("agent", health)).toBe(false);
  });
});
