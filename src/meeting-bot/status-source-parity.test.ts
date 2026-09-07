import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createMeetingStatusCallSource } from "./status-call-source.js";
import { createMeetingStatusPreludeSource } from "./status-prejoin-source.js";

const platforms = [
  {
    name: "Teams",
    token: "teams",
    globals: {
      audioOutputs: "__openclawTeamsAudioOutputs",
      captionArchive: "__openclawTeamsCaptionArchive",
      captions: "__openclawTeamsCaptions",
      meeting: "__openclawTeamsMeeting",
    },
  },
  {
    name: "Zoom",
    token: "zoom",
    globals: {
      audioOutputs: "__openclawZoomAudioOutputs",
      captionArchive: "__openclawZoomCaptionArchive",
      captions: "__openclawZoomCaptions",
      meeting: "__openclawZoomMeeting",
    },
  },
] as const;

describe.each(platforms)("$name meeting status source parity", (platform) => {
  const preludeOptions = {
    controlLookupSource: "const findTextButton = () => undefined;",
    lifecycleSource: ["const microphoneState = undefined;", "const cameraState = undefined;"].join(
      "\n",
    ),
    manualActionSource: "const clickedJoin = false;",
    platform: {
      displayName: platform.name,
      globals: platform.globals,
      manualActionReasonPrefix: platform.token,
    },
  };
  const preludeParams = {
    allowMicrophone: false,
    allowSessionAdoption: false,
    autoJoin: false,
    captureCaptions: false,
    expectedIdentity: `${platform.token}:meeting`,
    guestName: "OpenClaw",
    pageIdentitySource: "const meetingIdentity = () => undefined;",
    selectors: "{}",
    toggleStateFunction: "() => undefined",
    waitForInCallMs: 30_000,
  };

  it("threads typed platform globals and reasons through deterministic shared sources", () => {
    const callOptions = {
      captionEnableSource: "captionsEnabledNow = true;",
      platform: {
        audioOutputElementIdPrefix: `openclaw-${platform.token}-audio-output-`,
        displayName: platform.name,
        globals: {
          audioOutputs: platform.globals.audioOutputs,
          captions: platform.globals.captions,
          meeting: platform.globals.meeting,
        },
        manualActionReasonPrefix: platform.token,
      },
    };
    const callSource = createMeetingStatusCallSource(callOptions);
    const preludeSource = createMeetingStatusPreludeSource(preludeParams, preludeOptions);

    expect(callSource).toContain(`window["${platform.globals.audioOutputs}"]`);
    expect(callSource).toContain(`"${platform.token}-audio-choice-required"`);
    expect(preludeSource).toContain(`window["${platform.globals.captionArchive}"]`);
    expect(preludeSource).toContain(`"${platform.token}-session-conflict"`);
    expect(createMeetingStatusCallSource(callOptions)).toBe(callSource);
    expect(createMeetingStatusPreludeSource(preludeParams, preludeOptions)).toBe(preludeSource);
  });

  it("preserves audio helper declarations supplied by released plugin lifecycle fragments", async () => {
    const source = createMeetingStatusPreludeSource(preludeParams, {
      ...preludeOptions,
      // Published plugin fragments declare these names in the generated function's body.
      lifecycleSource: `
        const isVirtualAudioDevice = (value) => value === "plugin device";
        const isVirtualAudioDeviceNode = (node) => isVirtualAudioDevice(node.label);
        const microphoneDeviceRoots = () => ({ control: { label: "plugin device" }, roots: [] });
        const selectedMicrophoneLabel = () => {
          const { control } = microphoneDeviceRoots();
          return isVirtualAudioDeviceNode(control) ? control.label : undefined;
        };
        const microphoneState = "off";
        const cameraState = "off";`,
      manualActionSource: "return selectedMicrophoneLabel();",
    });
    await expect(
      runInNewContext(`(${source}})()`, {
        document: {},
        location: { href: "https://example.test/meeting" },
        window: {},
      }),
    ).resolves.toBe("plugin device");
  });
});
