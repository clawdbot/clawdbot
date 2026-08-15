import { describe, expect, it } from "vitest";
import {
  abortingMedia,
  audioStatusParams,
  continueStatusScript,
  control,
  liveMediaStream,
  pageMedia,
  runAudioStatusScript,
  runStatusScript,
  type PageMedia,
} from "./teams-meetings-platform-adapter.test-helpers.js";

describe("Microsoft Teams meeting audio routing", () => {
  it("does not let one routed element hide a failed live remote stream", async () => {
    const routed = pageMedia();
    const live = abortingMedia("The element has no supported source.", {
      sinkId: "built-in-output",
      srcObject: liveMediaStream(),
    });
    const bridge = abortingMedia("Cannot route bridge.", {
      isConnected: false,
      async play() {},
    });
    const { result } = await runAudioStatusScript({
      bridgeMedia: bridge,
      media: [routed, live],
      priorMeeting: {
        audioInputDeviceId: "blackhole-input",
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    });

    expect(result).toMatchObject({
      audioInputRouted: true,
      audioOutputRouted: false,
      audioOutputRouteRetryable: true,
      manualAction: { reason: "teams-audio-choice-required" },
    });
  });

  it("does not let one routed element hide an unloaded pending remote stream", async () => {
    const routed = pageMedia();
    const pending = abortingMedia("The element has no supported source.", {
      muted: false,
      readyState: 0,
      sinkId: "built-in-output",
      src: "blob:https://teams.live.com/pending-remote-audio",
    });
    const { result, window } = await runAudioStatusScript({
      media: [routed, pending],
      priorMeeting: {
        audioInputDeviceId: "blackhole-input",
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    });

    expect(result).toMatchObject({
      audioInputRouted: true,
      audioOutputRouted: false,
      manualAction: { reason: "teams-audio-choice-required" },
    });
    expect(result.audioOutputRouteError).toBeUndefined();
    expect(window["__openclawTeamsAudioOutputs"]).toEqual([
      expect.objectContaining({ source: pending, suspended: true }),
    ]);
  });

  it("retries bridge playback instead of trusting a previously selected sink", async () => {
    const source = abortingMedia("The element has no supported source.", {
      muted: false,
      sinkId: "built-in-output",
      srcObject: liveMediaStream(),
    });
    let playAttempts = 0;
    const bridge = pageMedia({
      isConnected: false,
      async play() {
        playAttempts += 1;
        throw new DOMException("Playback blocked.", "NotAllowedError");
      },
    });
    const params = audioStatusParams({
      bridgeMedia: bridge,
      media: [source],
      priorMeeting: {
        audioInputDeviceId: "blackhole-input",
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    });
    const first = await runStatusScript(params);
    const second = await continueStatusScript(first, params);

    expect(first.result.audioOutputRouted).toBe(false);
    expect(first.result.audioOutputRouteRetryable).toBe(false);
    expect(second.result.audioOutputRouted).toBe(false);
    expect(playAttempts).toBe(2);
    expect(source.muted).toBe(true);
  });

  it("keeps an unloaded source muted until its attached MediaStream is routed", async () => {
    const source: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      async setSinkId(value) {
        if (!source.srcObject) {
          throw new DOMException("The element has no supported source.", "AbortError");
        }
        source.sinkId = value;
      },
    };
    const params = audioStatusParams({
      media: [source],
    });
    const first = await runStatusScript(params);
    expect(first.result.audioOutputRouted).toBe(false);
    expect(first.result.audioOutputRouteError).toBeUndefined();
    expect(first.result.audioOutputRouteRetryable).toBe(true);
    expect(source.muted).toBe(true);
    expect(first.window["__openclawTeamsAudioOutputs"]).toEqual([
      expect.objectContaining({ pending: true, source, sourceMuted: false }),
    ]);

    const stream = liveMediaStream();
    source.srcObject = stream;
    expect(source.sinkId).toBe("built-in-output");
    expect(source.muted).toBe(true);
    expect(first.window["__openclawTeamsAudioOutputs"]).toEqual([
      expect.objectContaining({ pending: true, source, sourceMuted: false }),
    ]);

    const second = await continueStatusScript(first, params);
    expect(second.result.audioOutputRouted).toBe(true);
    expect(source.muted).toBe(false);
    expect(second.window).not.toHaveProperty("__openclawTeamsAudioOutputs");
  });

  it("does not route a pending source after the tab changes meetings", async () => {
    const source: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      async setSinkId(value) {
        if (!source.srcObject) {
          throw new DOMException("The element has no supported source.", "AbortError");
        }
        source.sinkId = value;
      },
    };
    const params = audioStatusParams({
      media: [source],
    });
    const first = await runStatusScript(params);

    source.srcObject = liveMediaStream();
    const conflict = await continueStatusScript(first, {
      ...params,
      currentUrl: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_other%40thread.v2/0",
    });

    expect(source.sinkId).toBe("built-in-output");
    expect(source.muted).toBe(true);
    expect(conflict.result.manualAction).toMatchObject({ reason: "teams-session-conflict" });
    expect(conflict.window).not.toHaveProperty("__openclawTeamsAudioOutputs");
  });

  it("keeps the source muted when a previously working bridge fails", async () => {
    const source = abortingMedia("The element has no supported source.", {
      muted: false,
      sinkId: "built-in-output",
      srcObject: liveMediaStream(),
    });
    let failPlayback = false;
    const bridge = pageMedia({
      isConnected: false,
      async play() {
        if (failPlayback) {
          throw new DOMException("Playback failed.", "AbortError");
        }
      },
    });
    const params = audioStatusParams({
      bridgeMedia: bridge,
      media: [source],
    });
    const first = await runStatusScript(params);
    expect(first.result.audioOutputRouted).toBe(true);
    expect(source.muted).toBe(true);

    failPlayback = true;
    const second = await continueStatusScript(first, params);
    expect(second.result.audioOutputRouted).toBe(false);
    expect(second.result.audioOutputRouteRetryable).toBe(true);
    expect(source.muted).toBe(true);

    failPlayback = false;
    const third = await continueStatusScript(second, params);
    expect(third.result.audioOutputRouted).toBe(true);
    expect(source.muted).toBe(true);
  });

  it("keeps a per-source bridge when another element sharing its stream routes directly", async () => {
    const stream = liveMediaStream();
    const bridgedSource = abortingMedia("The element has no supported source.", {
      muted: false,
      sinkId: "built-in-output",
      srcObject: stream,
    });
    const directSource = pageMedia({
      muted: false,
      sinkId: "built-in-output",
      srcObject: stream,
    });
    const bridge = pageMedia({
      isConnected: false,
      async play() {},
    });
    const { result, window } = await runAudioStatusScript({
      bridgeMedia: bridge,
      media: [bridgedSource, directSource],
    });

    expect(result.audioOutputRouted).toBe(true);
    expect(bridgedSource.muted).toBe(true);
    expect(directSource.muted).toBe(false);
    expect(window["__openclawTeamsAudioOutputs"]).toHaveLength(1);
    expect((window["__openclawTeamsAudioOutputs"] as Array<{ source: unknown }>)[0]?.source).toBe(
      bridgedSource,
    );
  });

  it("restores an unclaimed source when another source from its entry is rerouted", async () => {
    const current = pageMedia({
      currentSrc: "blob:https://teams.live.com/current",
      muted: true,
      sinkId: "built-in-output",
    });
    const unclaimed = pageMedia({
      currentSrc: "blob:https://teams.live.com/unclaimed",
      muted: true,
      sinkId: "built-in-output",
      async setSinkId() {},
    });

    const { result, window } = await runAudioStatusScript({
      media: [current],
      priorAudioOutputs: [
        {
          sessionId: "session-1",
          sources: [
            { element: current, muted: false, url: current.currentSrc },
            { element: unclaimed, muted: false, url: unclaimed.currentSrc },
          ],
        },
      ],
    });

    expect(result.audioOutputRouted).toBe(true);
    expect(current.muted).toBe(false);
    expect(unclaimed.muted).toBe(false);
    expect(window).not.toHaveProperty("__openclawTeamsAudioOutputs");
  });

  it("reroutes a replacement stream on an element muted by its prior bridge", async () => {
    const firstStream = liveMediaStream();
    const replacementStream = liveMediaStream();
    const source = abortingMedia("The element has no supported source.", {
      muted: false,
      sinkId: "built-in-output",
      srcObject: firstStream,
    });
    const directSource = pageMedia({
      muted: false,
      sinkId: "built-in-output",
      srcObject: firstStream,
    });
    const bridge = pageMedia({
      isConnected: false,
      async play() {},
    });
    const params = audioStatusParams({
      bridgeMedia: bridge,
      media: [source, directSource],
    });
    const first = await runStatusScript(params);
    expect(first.result.audioOutputRouted).toBe(true);
    expect(source.muted).toBe(true);

    source.srcObject = undefined;
    const second = await continueStatusScript(first, params);
    expect(second.result.audioOutputRouted).toBe(false);
    expect(source.muted).toBe(true);
    expect(second.window["__openclawTeamsAudioOutputs"]).toEqual([
      expect.objectContaining({ pending: true, source, sourceMuted: false }),
    ]);

    source.srcObject = replacementStream;
    const third = await continueStatusScript(second, params);
    expect(third.result.audioOutputRouted).toBe(true);
    expect(source.muted).toBe(true);
    expect(
      (third.window["__openclawTeamsAudioOutputs"] as Array<{ stream: unknown }>)[0]?.stream,
    ).toBe(replacementStream);
  });

  it("keeps a detached source muted after its owned stream is cleared", async () => {
    const stream = liveMediaStream();
    const source = abortingMedia("The element has no supported source.", {
      muted: false,
      sinkId: "built-in-output",
      srcObject: stream,
    });
    const directSource = pageMedia({
      muted: false,
      sinkId: "built-in-output",
      srcObject: stream,
    });
    const bridge = pageMedia({
      isConnected: false,
      async play() {},
    });
    const params = audioStatusParams({
      bridgeMedia: bridge,
    });
    const first = await runStatusScript({ ...params, media: [source] });
    expect(source.muted).toBe(true);

    const second = await continueStatusScript(first, {
      ...params,
      media: [directSource],
    });
    expect(second.result.audioOutputRouted).toBe(true);
    expect(source.muted).toBe(true);
    expect(second.window["__openclawTeamsAudioOutputs"]).toEqual([
      expect.objectContaining({ detached: true, source, sourceMuted: false, suspended: true }),
    ]);

    source.srcObject = undefined;
    const third = await continueStatusScript(second, {
      ...params,
      media: [directSource],
    });
    expect(source.muted).toBe(true);
    expect(third.window).not.toHaveProperty("__openclawTeamsAudioOutputs");
  });

  it("tears down audio bridges and restores sources after the call ends", async () => {
    const source: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      srcObject: liveMediaStream(),
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
    let pauses = 0;
    let removals = 0;
    const bridge = pageMedia({
      isConnected: false,
      async play() {},
      pause: () => (pauses += 1),
      remove: () => (removals += 1),
    });
    const first = await runAudioStatusScript({
      bridgeMedia: bridge,
      media: [source],
    });
    expect(source.muted).toBe(true);

    const ended = await continueStatusScript(first, { allowMicrophone: true });
    expect(source.muted).toBe(false);
    expect(pauses).toBe(1);
    expect(removals).toBe(1);
    expect(ended.window).not.toHaveProperty("__openclawTeamsAudioOutputs");
  });

  it("does not restore a reused media element carrying a replacement stream", async () => {
    const bridgedStream = liveMediaStream();
    const replacementStream = liveMediaStream();
    const source: PageMedia = {
      muted: true,
      sinkId: "built-in-output",
      srcObject: replacementStream,
      async setSinkId() {},
    };
    let pauses = 0;
    let removals = 0;
    const bridge: PageMedia = {
      sinkId: "blackhole-output",
      pause: () => (pauses += 1),
      remove: () => (removals += 1),
      async setSinkId() {},
    };

    const ended = await runStatusScript({
      allowMicrophone: true,
      priorAudioOutputs: [
        {
          bridge,
          playing: true,
          sessionId: "session-1",
          source,
          sourceMuted: false,
          stream: bridgedStream,
        },
      ],
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
    });

    expect(source.muted).toBe(true);
    expect(source.srcObject).toBe(replacementStream);
    expect(pauses).toBe(1);
    expect(removals).toBe(1);
    expect(ended.window).not.toHaveProperty("__openclawTeamsAudioOutputs");
  });

  it("does not restore a reused URL-backed media element", async () => {
    const source: PageMedia = {
      currentSrc: "blob:https://teams.live.com/replacement",
      muted: true,
      sinkId: "built-in-output",
      async setSinkId() {},
    };
    const bridge: PageMedia = {
      sinkId: "blackhole-output",
      async setSinkId() {},
    };

    const ended = await runStatusScript({
      allowMicrophone: true,
      priorAudioOutputs: [
        {
          bridge,
          sessionId: "session-1",
          source,
          sourceMuted: false,
          sourceUrl: "blob:https://teams.live.com/original",
        },
      ],
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
    });

    expect(source.muted).toBe(true);
    expect(ended.window).not.toHaveProperty("__openclawTeamsAudioOutputs");
  });

  it("does not infer identity for a legacy URL-backed entry", async () => {
    const source: PageMedia = {
      currentSrc: "blob:https://teams.live.com/original",
      muted: true,
      sinkId: "built-in-output",
      async setSinkId() {},
    };

    await runStatusScript({
      allowMicrophone: true,
      priorAudioOutputs: [
        {
          sessionId: "session-1",
          source,
          sourceMuted: false,
        },
      ],
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
    });

    expect(source.muted).toBe(true);
  });

  it("restores pending and legacy sources-array entries during status cleanup", async () => {
    const pending: PageMedia = { muted: true, sinkId: "", async setSinkId() {} };
    const legacy: PageMedia = {
      currentSrc: "blob:https://teams.live.com/legacy",
      muted: true,
      sinkId: "",
      async setSinkId() {},
    };

    await runStatusScript({
      allowMicrophone: true,
      priorAudioOutputs: [
        {
          sessionId: "session-1",
          sources: [
            { element: pending, muted: false, pending: true },
            { element: legacy, muted: false },
          ],
        },
      ],
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
    });

    expect(pending.muted).toBe(true);
    expect(legacy.muted).toBe(true);
  });

  it("suspends bridge ownership while an in-call media list is temporarily empty", async () => {
    const stream = liveMediaStream();
    const source: PageMedia = {
      muted: true,
      sinkId: "built-in-output",
      srcObject: stream,
      async setSinkId() {},
    };
    let pauses = 0;
    let removals = 0;
    const bridge: PageMedia = {
      sinkId: "blackhole-output",
      pause: () => (pauses += 1),
      remove: () => (removals += 1),
      async setSinkId() {},
    };

    const { result, window } = await runStatusScript({
      allowMicrophone: true,
      devices: [{ deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" }],
      leave: control({ label: "Leave" }),
      media: [],
      priorAudioOutputs: [
        {
          bridge,
          playing: true,
          sessionId: "session-1",
          source,
          sourceMuted: false,
          stream,
        },
      ],
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
    });

    expect(source.muted).toBe(true);
    expect(result.audioOutputRouteRetryable).toBe(true);
    expect(source.srcObject).toBe(stream);
    expect(pauses).toBe(1);
    expect(removals).toBe(1);
    expect(window["__openclawTeamsAudioOutputs"]).toEqual([
      expect.objectContaining({ source, sourceMuted: false, stream, suspended: true }),
    ]);
  });

  it("tears down a bridge when the BlackHole output disappears in-call", async () => {
    const source: PageMedia = {
      muted: true,
      sinkId: "built-in-output",
      srcObject: liveMediaStream(),
      async setSinkId() {},
    };
    let pauses = 0;
    let removals = 0;
    const bridge: PageMedia = {
      isConnected: true,
      sinkId: "blackhole-output",
      pause: () => (pauses += 1),
      remove: () => (removals += 1),
      async setSinkId() {},
    };
    const { result, window } = await runAudioStatusScript({
      devices: [{ deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" }],
      media: [source],
      priorAudioOutputs: [
        {
          bridge,
          playing: true,
          sessionId: "session-1",
          source,
          sourceMuted: false,
          stream: source.srcObject,
        },
      ],
    });

    expect(source.muted).toBe(true);
    expect(result.audioOutputRouteRetryable).toBe(false);
    expect(pauses).toBe(1);
    expect(removals).toBe(1);
    expect(window["__openclawTeamsAudioOutputs"]).toEqual([
      expect.objectContaining({ source, sourceMuted: false, suspended: true }),
    ]);
  });

  it("does not tear down audio bridges during read-only inspection", async () => {
    const source: PageMedia = {
      muted: true,
      sinkId: "built-in-output",
      srcObject: liveMediaStream(),
      async setSinkId() {},
    };
    let pauses = 0;
    let removals = 0;
    const bridge: PageMedia = {
      isConnected: true,
      sinkId: "blackhole-output",
      pause: () => (pauses += 1),
      remove: () => (removals += 1),
      async setSinkId() {},
    };
    const activeBridge = {
      bridge,
      playing: true,
      sessionId: "session-1",
      source,
      sourceMuted: false,
      stream: source.srcObject,
    };
    const { window } = await runAudioStatusScript({
      devices: [{ deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" }],
      media: [source],
      priorAudioOutputs: [activeBridge],
      readOnly: true,
    });

    expect(source.muted).toBe(true);
    expect(pauses).toBe(0);
    expect(removals).toBe(0);
    expect(window["__openclawTeamsAudioOutputs"]).toEqual([activeBridge]);
  });

  it("reassigns a prior session bridge source after the new session identity is verified", async () => {
    const stream = liveMediaStream();
    const source: PageMedia = { muted: true, sinkId: "", srcObject: stream, async setSinkId() {} };
    const emptySource: PageMedia = { muted: true, sinkId: "", async setSinkId() {} };
    let pauses = 0;
    let removals = 0;
    const bridge: PageMedia = {
      sinkId: "",
      pause: () => (pauses += 1),
      remove: () => (removals += 1),
      async setSinkId() {},
    };
    const { window } = await runStatusScript({
      leave: control({ label: "Leave" }),
      priorAudioOutputs: [
        {
          bridge,
          playing: true,
          sessionId: "old-session",
          sources: [
            { element: source, muted: false, stream },
            { element: emptySource, muted: false },
          ],
        },
        {
          bridge: { ...bridge },
          playing: true,
          sessionId: "old-session",
          source,
          sourceMuted: false,
          stream,
        },
      ],
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        sessionId: "old-session",
      },
    });

    expect(source.muted).toBe(true);
    expect(emptySource.muted).toBe(true);
    expect(pauses).toBe(2);
    expect(removals).toBe(2);
    expect(window["__openclawTeamsAudioOutputs"]).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        source,
        sourceMuted: false,
        suspended: true,
      }),
    ]);
  });

  it("ignores an unrelated media element when the live remote stream is routed", async () => {
    const live = pageMedia({ srcObject: liveMediaStream() });
    const unrelated: PageMedia = {
      muted: true,
      sinkId: "built-in-output",
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
    const { result } = await runAudioStatusScript({
      media: [live, unrelated],
      priorMeeting: {
        audioInputDeviceId: "blackhole-input",
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    });

    expect(result).toMatchObject({
      audioInputRouted: true,
      audioOutputRouted: true,
    });
    expect(result.manualAction).toBeUndefined();
  });

  it("keeps a loaded non-MediaStream AbortError retryable", async () => {
    const routed = pageMedia();
    const loaded: PageMedia = {
      currentSrc: "blob:https://teams.live.com/remote-audio",
      readyState: 4,
      sinkId: "built-in-output",
      async setSinkId() {
        throw new DOMException("Cannot route loaded media.", "AbortError");
      },
    };
    const { result } = await runAudioStatusScript({
      media: [routed, loaded],
    });

    expect(result).toMatchObject({
      audioOutputRouteError: "Cannot route loaded media.",
      audioOutputRouteRetryable: true,
      audioOutputRouted: false,
      manualAction: { reason: "teams-audio-choice-required" },
    });
  });

  it("preserves Teams mute state and ignores a muted local media stream", async () => {
    const remote = pageMedia({ muted: false, srcObject: liveMediaStream() });
    let localRouteAttempts = 0;
    const local: PageMedia = {
      muted: true,
      sinkId: "built-in-output",
      srcObject: liveMediaStream(),
      async setSinkId() {
        localRouteAttempts += 1;
      },
    };
    const params = audioStatusParams();
    const pending = await runStatusScript({ ...params, media: [local] });
    expect(pending.result).toMatchObject({
      audioInputRouted: true,
      audioOutputRouted: false,
      audioOutputRouteRetryable: true,
    });

    const { result } = await runStatusScript({ ...params, media: [remote, local] });

    expect(result.audioOutputRouted).toBe(true);
    expect(local.muted).toBe(true);
    expect(localRouteAttempts).toBe(0);
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
      manualAction: { reason: "teams-audio-choice-required" },
      micMuted: true,
    });
    expect(microphone.clicks).toBe(1);
  });
});
