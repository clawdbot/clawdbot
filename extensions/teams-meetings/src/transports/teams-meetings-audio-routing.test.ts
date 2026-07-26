import { describe, expect, it } from "vitest";
import {
  MEETING_STATE_KEY,
  control,
  runStatusScript,
  type PageMedia,
} from "./teams-meetings-platform-adapter.test-helpers.js";

describe("Microsoft Teams meeting audio routing", () => {
  it("does not let one routed element hide a failed live remote stream", async () => {
    const routed: PageMedia = {
      sinkId: "",
      async setSinkId(value) {
        routed.sinkId = value;
      },
    };
    const live: PageMedia = {
      sinkId: "built-in-output",
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
    const bridge: PageMedia = {
      isConnected: false,
      sinkId: "",
      async play() {},
      async setSinkId() {
        throw new DOMException("Cannot route bridge.", "AbortError");
      },
    };
    const { result } = await runStatusScript({
      allowMicrophone: true,
      bridgeMedia: bridge,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [routed, live],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: {
        audioInputDeviceId: "blackhole-input",
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    });

    expect(result).toMatchObject({
      audioInputRouted: true,
      audioOutputRouted: false,
      audioOutputRouteRetryable: true,
      manualActionReason: "teams-audio-choice-required",
    });
  });

  it("does not let one routed element hide an unloaded pending remote stream", async () => {
    const routed: PageMedia = {
      sinkId: "",
      async setSinkId(value) {
        routed.sinkId = value;
      },
    };
    const pending: PageMedia = {
      muted: false,
      readyState: 0,
      sinkId: "built-in-output",
      src: "blob:https://teams.live.com/pending-remote-audio",
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
    const { result, window } = await runStatusScript({
      allowMicrophone: true,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [routed, pending],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: {
        audioInputDeviceId: "blackhole-input",
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    });

    expect(result).toMatchObject({
      audioInputRouted: true,
      audioOutputRouted: false,
      manualActionReason: "teams-audio-choice-required",
    });
    expect(result.audioOutputRouteError).toBeUndefined();
    expect(window["__openclawTeamsAudioOutputs"]).toEqual([
      expect.objectContaining({ source: pending, suspended: true }),
    ]);
  });

  it("retries bridge playback instead of trusting a previously selected sink", async () => {
    const source: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
    let playAttempts = 0;
    const bridge: PageMedia = {
      isConnected: false,
      sinkId: "",
      async play() {
        playAttempts += 1;
        throw new DOMException("Playback blocked.", "NotAllowedError");
      },
      async setSinkId(value) {
        bridge.sinkId = value;
      },
    };
    const params = {
      allowMicrophone: true,
      bridgeMedia: bridge,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [source],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      priorMeeting: {
        audioInputDeviceId: "blackhole-input",
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    };
    const first = await runStatusScript(params);
    const second = await runStatusScript({
      ...params,
      priorAudioOutputs: first.window["__openclawTeamsAudioOutputs"] as unknown[],
      priorMeeting: first.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });

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
    const params = {
      allowMicrophone: true,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [source],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
    };
    const first = await runStatusScript(params);
    expect(first.result.audioOutputRouted).toBe(false);
    expect(first.result.audioOutputRouteError).toBeUndefined();
    expect(first.result.audioOutputRouteRetryable).toBe(true);
    expect(source.muted).toBe(true);
    expect(first.window["__openclawTeamsAudioOutputs"]).toEqual([
      expect.objectContaining({ pending: true, source, sourceMuted: false }),
    ]);

    const stream = { getAudioTracks: () => [{ readyState: "live" }] };
    source.srcObject = stream;
    expect(source.sinkId).toBe("built-in-output");
    expect(source.muted).toBe(true);
    expect(first.window["__openclawTeamsAudioOutputs"]).toEqual([
      expect.objectContaining({ pending: true, source, sourceMuted: false }),
    ]);

    const second = await runStatusScript({
      ...params,
      priorAudioOutputs: first.window["__openclawTeamsAudioOutputs"] as unknown[],
      priorMeeting: first.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });
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
    const params = {
      allowMicrophone: true,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [source],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
    };
    const first = await runStatusScript(params);

    source.srcObject = { getAudioTracks: () => [{ readyState: "live" }] };
    const conflict = await runStatusScript({
      ...params,
      currentUrl: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_other%40thread.v2/0",
      priorAudioOutputs: first.window["__openclawTeamsAudioOutputs"] as unknown[],
      priorMeeting: first.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });

    expect(source.sinkId).toBe("built-in-output");
    expect(source.muted).toBe(true);
    expect(conflict.result.manualActionReason).toBe("teams-session-conflict");
    expect(conflict.window).not.toHaveProperty("__openclawTeamsAudioOutputs");
  });

  it("keeps the source muted when a previously working bridge fails", async () => {
    const source: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
    let failPlayback = false;
    const bridge: PageMedia = {
      isConnected: false,
      sinkId: "",
      async play() {
        if (failPlayback) {
          throw new DOMException("Playback failed.", "AbortError");
        }
      },
      async setSinkId(value) {
        bridge.sinkId = value;
      },
    };
    const params = {
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
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
    };
    const first = await runStatusScript(params);
    expect(first.result.audioOutputRouted).toBe(true);
    expect(source.muted).toBe(true);

    failPlayback = true;
    const second = await runStatusScript({
      ...params,
      priorAudioOutputs: first.window["__openclawTeamsAudioOutputs"] as unknown[],
      priorMeeting: first.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });
    expect(second.result.audioOutputRouted).toBe(false);
    expect(second.result.audioOutputRouteRetryable).toBe(true);
    expect(source.muted).toBe(true);

    failPlayback = false;
    const third = await runStatusScript({
      ...params,
      priorAudioOutputs: second.window["__openclawTeamsAudioOutputs"] as unknown[],
      priorMeeting: second.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });
    expect(third.result.audioOutputRouted).toBe(true);
    expect(source.muted).toBe(true);
  });

  it("keeps a per-source bridge when another element sharing its stream routes directly", async () => {
    const stream = { getAudioTracks: () => [{ readyState: "live" }] };
    const bridgedSource: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      srcObject: stream,
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
    const directSource: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      srcObject: stream,
      async setSinkId(value) {
        directSource.sinkId = value;
      },
    };
    const bridge: PageMedia = {
      isConnected: false,
      sinkId: "",
      async play() {},
      async setSinkId(value) {
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
      media: [bridgedSource, directSource],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
      },
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
    const current: PageMedia = {
      currentSrc: "blob:https://teams.live.com/current",
      muted: true,
      sinkId: "built-in-output",
      async setSinkId(value) {
        current.sinkId = value;
      },
    };
    const unclaimed: PageMedia = {
      currentSrc: "blob:https://teams.live.com/unclaimed",
      muted: true,
      sinkId: "built-in-output",
      async setSinkId() {},
    };

    const { result, window } = await runStatusScript({
      allowMicrophone: true,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [current],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorAudioOutputs: [
        {
          sessionId: "session-1",
          sources: [
            { element: current, muted: false, url: current.currentSrc },
            { element: unclaimed, muted: false, url: unclaimed.currentSrc },
          ],
        },
      ],
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
    });

    expect(result.audioOutputRouted).toBe(true);
    expect(current.muted).toBe(false);
    expect(unclaimed.muted).toBe(false);
    expect(window).not.toHaveProperty("__openclawTeamsAudioOutputs");
  });

  it("reroutes a replacement stream on an element muted by its prior bridge", async () => {
    const firstStream = { getAudioTracks: () => [{ readyState: "live" }] };
    const replacementStream = { getAudioTracks: () => [{ readyState: "live" }] };
    const source: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      srcObject: firstStream,
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
    const directSource: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      srcObject: firstStream,
      async setSinkId(value) {
        directSource.sinkId = value;
      },
    };
    const bridge: PageMedia = {
      isConnected: false,
      sinkId: "",
      async play() {},
      async setSinkId(value) {
        bridge.sinkId = value;
      },
    };
    const params = {
      allowMicrophone: true,
      bridgeMedia: bridge,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [source, directSource],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    };
    const first = await runStatusScript(params);
    expect(first.result.audioOutputRouted).toBe(true);
    expect(source.muted).toBe(true);

    source.srcObject = undefined;
    const second = await runStatusScript({
      ...params,
      priorAudioOutputs: first.window["__openclawTeamsAudioOutputs"] as unknown[],
      priorMeeting: first.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });
    expect(second.result.audioOutputRouted).toBe(false);
    expect(source.muted).toBe(true);
    expect(second.window["__openclawTeamsAudioOutputs"]).toEqual([
      expect.objectContaining({ pending: true, source, sourceMuted: false }),
    ]);

    source.srcObject = replacementStream;
    const third = await runStatusScript({
      ...params,
      priorAudioOutputs: second.window["__openclawTeamsAudioOutputs"] as unknown[],
      priorMeeting: second.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });
    expect(third.result.audioOutputRouted).toBe(true);
    expect(source.muted).toBe(true);
    expect(
      (third.window["__openclawTeamsAudioOutputs"] as Array<{ stream: unknown }>)[0]?.stream,
    ).toBe(replacementStream);
  });

  it("keeps a detached source muted after its owned stream is cleared", async () => {
    const stream = { getAudioTracks: () => [{ readyState: "live" }] };
    const source: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      srcObject: stream,
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
    const directSource: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      srcObject: stream,
      async setSinkId(value) {
        directSource.sinkId = value;
      },
    };
    const bridge: PageMedia = {
      isConnected: false,
      sinkId: "",
      async play() {},
      async setSinkId(value) {
        bridge.sinkId = value;
      },
    };
    const params = {
      allowMicrophone: true,
      bridgeMedia: bridge,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
    };
    const first = await runStatusScript({ ...params, media: [source] });
    expect(source.muted).toBe(true);

    const second = await runStatusScript({
      ...params,
      media: [directSource],
      priorAudioOutputs: first.window["__openclawTeamsAudioOutputs"] as unknown[],
      priorMeeting: first.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });
    expect(second.result.audioOutputRouted).toBe(true);
    expect(source.muted).toBe(true);
    expect(second.window["__openclawTeamsAudioOutputs"]).toEqual([
      expect.objectContaining({ detached: true, source, sourceMuted: false, suspended: true }),
    ]);

    source.srcObject = undefined;
    const third = await runStatusScript({
      ...params,
      media: [directSource],
      priorAudioOutputs: second.window["__openclawTeamsAudioOutputs"] as unknown[],
      priorMeeting: second.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });
    expect(source.muted).toBe(true);
    expect(third.window).not.toHaveProperty("__openclawTeamsAudioOutputs");
  });

  it("tears down audio bridges and restores sources after the call ends", async () => {
    const source: PageMedia = {
      muted: false,
      sinkId: "built-in-output",
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
    let pauses = 0;
    let removals = 0;
    const bridge: PageMedia = {
      isConnected: false,
      sinkId: "",
      async play() {},
      pause: () => (pauses += 1),
      remove: () => (removals += 1),
      async setSinkId(value) {
        bridge.sinkId = value;
      },
    };
    const first = await runStatusScript({
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
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
    });
    expect(source.muted).toBe(true);

    const ended = await runStatusScript({
      allowMicrophone: true,
      priorAudioOutputs: first.window["__openclawTeamsAudioOutputs"] as unknown[],
      priorMeeting: first.window[MEETING_STATE_KEY] as Record<string, unknown>,
    });
    expect(source.muted).toBe(false);
    expect(pauses).toBe(1);
    expect(removals).toBe(1);
    expect(ended.window).not.toHaveProperty("__openclawTeamsAudioOutputs");
  });

  it("does not restore a reused media element carrying a replacement stream", async () => {
    const bridgedStream = { getAudioTracks: () => [{ readyState: "live" }] };
    const replacementStream = { getAudioTracks: () => [{ readyState: "live" }] };
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
    const stream = { getAudioTracks: () => [{ readyState: "live" }] };
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
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
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
    const { result, window } = await runStatusScript({
      allowMicrophone: true,
      devices: [{ deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" }],
      leave: control({ label: "Leave" }),
      media: [source],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
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
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
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
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
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
    const { window } = await runStatusScript({
      allowMicrophone: true,
      devices: [{ deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" }],
      leave: control({ label: "Leave" }),
      media: [source],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorAudioOutputs: [activeBridge],
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
      readOnly: true,
    });

    expect(source.muted).toBe(true);
    expect(pauses).toBe(0);
    expect(removals).toBe(0);
    expect(window["__openclawTeamsAudioOutputs"]).toEqual([activeBridge]);
  });

  it("reassigns a prior session bridge source after the new session identity is verified", async () => {
    const stream = { getAudioTracks: () => [{ readyState: "live" }] };
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
      allowMicrophone: false,
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
    const live: PageMedia = {
      sinkId: "",
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
      async setSinkId(value) {
        live.sinkId = value;
      },
    };
    const unrelated: PageMedia = {
      muted: true,
      sinkId: "built-in-output",
      async setSinkId() {
        throw new DOMException("The element has no supported source.", "AbortError");
      },
    };
    const { result } = await runStatusScript({
      allowMicrophone: true,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [live, unrelated],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: {
        audioInputDeviceId: "blackhole-input",
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    });

    expect(result).toMatchObject({
      audioInputRouted: true,
      audioOutputRouted: true,
      manualActionRequired: false,
    });
  });

  it("keeps a loaded non-MediaStream AbortError retryable", async () => {
    const routed: PageMedia = {
      sinkId: "",
      async setSinkId(value) {
        routed.sinkId = value;
      },
    };
    const loaded: PageMedia = {
      currentSrc: "blob:https://teams.live.com/remote-audio",
      readyState: 4,
      sinkId: "built-in-output",
      async setSinkId() {
        throw new DOMException("Cannot route loaded media.", "AbortError");
      },
    };
    const { result } = await runStatusScript({
      allowMicrophone: true,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      media: [routed, loaded],
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: { identity: "teams-work:19:meeting_test@thread.v2" },
    });

    expect(result).toMatchObject({
      audioOutputRouteError: "Cannot route loaded media.",
      audioOutputRouteRetryable: true,
      audioOutputRouted: false,
      manualActionReason: "teams-audio-choice-required",
    });
  });

  it("preserves Teams mute state and ignores a muted local media stream", async () => {
    const remote: PageMedia = {
      muted: false,
      sinkId: "",
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
      async setSinkId(value) {
        remote.sinkId = value;
      },
    };
    let localRouteAttempts = 0;
    const local: PageMedia = {
      muted: true,
      sinkId: "built-in-output",
      srcObject: { getAudioTracks: () => [{ readyState: "live" }] },
      async setSinkId() {
        localRouteAttempts += 1;
      },
    };
    const params = {
      allowMicrophone: true,
      devices: [
        { deviceId: "blackhole-input", kind: "audioinput", label: "BlackHole 2ch" },
        { deviceId: "blackhole-output", kind: "audiooutput", label: "BlackHole 2ch" },
      ],
      leave: control({ label: "Leave" }),
      microphone: control({ label: "Turn microphone off", pressed: true }),
      microphoneDevice: control({ label: "BlackHole 2ch" }),
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
      },
    };
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
      manualActionReason: "teams-audio-choice-required",
      micMuted: true,
    });
    expect(microphone.clicks).toBe(1);
  });
});
