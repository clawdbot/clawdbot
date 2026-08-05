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
    const preludeOptions = {
      controlLookupSource: "const findTextButton = () => undefined;",
      lifecycleSource: [
        "const microphoneState = undefined;",
        "const cameraState = undefined;",
      ].join("\n"),
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

    const callSource = createMeetingStatusCallSource(callOptions);
    const preludeSource = createMeetingStatusPreludeSource(preludeParams, preludeOptions);

    expect(callSource).toContain(`window["${platform.globals.audioOutputs}"]`);
    expect(callSource).toContain(`"${platform.token}-audio-choice-required"`);
    expect(preludeSource).toContain(`window["${platform.globals.captionArchive}"]`);
    expect(preludeSource).toContain(`"${platform.token}-session-conflict"`);
    expect(createMeetingStatusCallSource(callOptions)).toBe(callSource);
    expect(createMeetingStatusPreludeSource(preludeParams, preludeOptions)).toBe(preludeSource);
  });
});
