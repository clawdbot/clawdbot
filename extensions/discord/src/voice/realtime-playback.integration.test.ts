import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { createRealtimePlaybackFixture } from "./realtime-playback.integration.test-support.js";

it("acknowledges scoped marks only when the real resource consumes their PCM", async () => {
  const fixture = createRealtimePlaybackFixture();
  try {
    fixture.callbacks.onAudio(Buffer.alloc(24_000));
    const state = fixture.player.state;
    if (state.status === fixture.voiceSdk.AudioPlayerStatus.Idle) {
      throw new Error("expected first response resource");
    }
    const consumed: number[] = [];
    fixture.callbacks.onMark?.("first", () => {
      consumed.push(state.resource.playbackDuration);
      fixture.acknowledgeMark("first");
    });
    fixture.callbacks.onAudio(Buffer.alloc(24_000));
    fixture.callbacks.onMark?.("last", () => {
      consumed.push(state.resource.playbackDuration);
      fixture.acknowledgeMark("last");
    });
    fixture.callbacks.onResponseDone?.({ status: "completed" });
    expect(fixture.acknowledgeMark).not.toHaveBeenCalled();
    await fixture.voiceSdk.entersState(
      fixture.player,
      fixture.voiceSdk.AudioPlayerStatus.Idle,
      3_000,
    );
    expect(fixture.acknowledgeMark.mock.calls).toEqual([["first"], ["last"]]);
    expect(consumed).toEqual([500, 1_000]);
  } finally {
    fixture.close();
  }
});

it("retires the final consumed mark before a queued read microtask can lose it", async () => {
  const fixture = createRealtimePlaybackFixture();
  let restoreRead = () => {};
  try {
    fixture.callbacks.onAudio(Buffer.alloc(4_800));
    fixture.callbacks.onMark?.("last", () => fixture.acknowledgeMark("last"));
    fixture.callbacks.onResponseDone?.({ status: "completed" });
    const state = fixture.player.state;
    if (state.status === fixture.voiceSdk.AudioPlayerStatus.Idle) {
      throw new Error("expected short response resource");
    }
    const consume = state.resource.read.bind(state.resource);
    const read = vi.spyOn(state.resource, "read").mockImplementation(() => {
      const packet = consume();
      if (state.resource.playbackDuration === 100) {
        fixture.player.stop(true);
      }
      return packet;
    });
    restoreRead = () => read.mockRestore();
    await fixture.voiceSdk.entersState(
      fixture.player,
      fixture.voiceSdk.AudioPlayerStatus.Idle,
      3_000,
    );
    await Promise.resolve();
    expect(state.resource.playbackDuration).toBe(100);
    expect(fixture.acknowledgeMark.mock.calls).toEqual([["last"]]);
  } finally {
    restoreRead();
    fixture.close();
  }
});

it.each(["clear", "close"] as const)(
  "never acknowledges queued PCM discarded by %s",
  async (ending) => {
    const fixture = createRealtimePlaybackFixture();
    const queued = fixture.createLane();
    try {
      fixture.callbacks.onAudio(Buffer.alloc(24_000));
      fixture.callbacks.onResponseDone?.({ status: "completed" });
      queued.callbacks.onAudio(Buffer.alloc(24_000));
      queued.callbacks.onMark?.("unheard", () => queued.acknowledgeMark("unheard"));
      queued.callbacks.onResponseDone?.({ status: "completed" });
      if (ending === "clear") {
        queued.playback.clearOutputAudio();
      } else {
        queued.close();
      }
      await fixture.voiceSdk.entersState(
        fixture.player,
        fixture.voiceSdk.AudioPlayerStatus.Idle,
        3_000,
      );
      expect(queued.acknowledgeMark).not.toHaveBeenCalled();
      expect(queued.onTerminalError).not.toHaveBeenCalled();
    } finally {
      fixture.close();
    }
  },
);

it("fails only the speaker whose encoder discards unconsumed scoped marks", async () => {
  const fixture = createRealtimePlaybackFixture();
  const next = fixture.createLane();
  try {
    fixture.playback.enqueueExactSpeechMessage("first");
    fixture.callbacks.onAudio(Buffer.alloc(96_000));
    fixture.callbacks.onMark?.("unheard-tail", () => fixture.acknowledgeMark("unheard-tail"));
    fixture.callbacks.onResponseDone?.({ status: "completed" });
    fixture.playback.enqueueExactSpeechMessage("queued answer");
    next.callbacks.onAudio(Buffer.alloc(24_000));
    next.callbacks.onResponseDone?.({ status: "completed" });
    const state = fixture.player.state;
    if (state.status === fixture.voiceSdk.AudioPlayerStatus.Idle) {
      throw new Error("expected first speaker resource");
    }
    state.resource.playStream.destroy(new Error("synthetic encoder failure"));
    await vi.waitFor(() => expect(fixture.onTerminalError).toHaveBeenCalledOnce());
    expect(fixture.stopTerminally).toHaveBeenCalledOnce();
    expect(fixture.acknowledgeMark).not.toHaveBeenCalled();
    expect(fixture.sendUserMessage.mock.calls).toEqual([["first"]]);
    expect(next.onTerminalError).not.toHaveBeenCalled();
    await fixture.voiceSdk.entersState(
      fixture.player,
      fixture.voiceSdk.AudioPlayerStatus.Idle,
      3_000,
    );
    expect(next.playback.isOutputAudioActive()).toBe(false);
  } finally {
    fixture.close();
  }
});

it.each(["turn.started", "output.audio.started", "output.audio.delta"] as const)(
  "keeps playback cleared when a %s observer interrupts the incoming item",
  (eventType) => {
    let observed: unknown;
    const fixture = createRealtimePlaybackFixture((event) => {
      if (event.type === eventType) {
        observed = fixture.callbacks.getPlaybackState?.();
        fixture.callbacks.onClearAudio();
      }
    });
    try {
      fixture.callbacks.onAudio(Buffer.alloc(480), { itemId: "cancelled" });
      expect(observed).toEqual([{ itemId: "cancelled", audioEndMs: 0 }]);
      expect(fixture.callbacks.getPlaybackState?.()).toEqual([]);
      expect(fixture.playback.isOutputAudioActive()).toBe(false);
      expect(fixture.harness.outputActivity.snapshot().chunks).toBe(0);
      expect(fixture.player.state.status).toBe(fixture.voiceSdk.AudioPlayerStatus.Idle);
    } finally {
      fixture.close();
    }
  },
);

it("excludes fully heard items during the real player's trailing silence", async () => {
  const fixture = createRealtimePlaybackFixture();
  try {
    fixture.callbacks.onAudio(Buffer.alloc(24_000), { itemId: "heard" });
    fixture.callbacks.onResponseDone?.({ status: "completed" });
    await fixture.voiceSdk.entersState(
      fixture.player,
      fixture.voiceSdk.AudioPlayerStatus.Playing,
      3_000,
    );
    const state = fixture.player.state;
    if (state.status === fixture.voiceSdk.AudioPlayerStatus.Idle) {
      throw new Error("expected completed reply playback");
    }
    const resource = state.resource;
    const consume = resource.read.bind(resource);
    const read = vi.spyOn(resource, "read");
    try {
      await new Promise<void>((resolve) => {
        read.mockImplementation(() => {
          const packet = consume();
          if (resource.silenceRemaining > 0) {
            resolve();
          }
          return packet;
        });
      });
      expect(resource.playbackDuration).toBe(500);
      expect(fixture.player.state.status).toBe(fixture.voiceSdk.AudioPlayerStatus.Playing);
      expect(fixture.callbacks.getPlaybackState?.()).toEqual([]);
    } finally {
      read.mockRestore();
    }
  } finally {
    fixture.close();
  }
});

it("reports consumed native items in playback order when a newer response is queued", async () => {
  const fixture = createRealtimePlaybackFixture();
  try {
    fixture.callbacks.onAudio(Buffer.alloc(96_000), { itemId: "audible" });
    fixture.callbacks.onResponseDone?.({ status: "completed" });
    await fixture.voiceSdk.entersState(
      fixture.player,
      fixture.voiceSdk.AudioPlayerStatus.Playing,
      3_000,
    );
    const state = fixture.player.state;
    if (state.status === fixture.voiceSdk.AudioPlayerStatus.Idle) {
      throw new Error("expected audible response");
    }
    await vi.waitFor(() => expect(state.resource.playbackDuration).toBeGreaterThanOrEqual(300));
    fixture.callbacks.onAudio(Buffer.alloc(4_800), { itemId: "queued" });
    fixture.callbacks.onResponseDone?.({ status: "completed" });
    expect(fixture.callbacks.getPlaybackState?.()).toEqual([
      { itemId: "audible", audioEndMs: state.resource.playbackDuration },
      { itemId: "queued", audioEndMs: 0 },
    ]);
    fixture.playback.speakControlResult("Stopped.");
    expect(fixture.callbacks.getPlaybackState?.()).toEqual([]);
    expect(fixture.player.state.status).toBe(fixture.voiceSdk.AudioPlayerStatus.Idle);
  } finally {
    fixture.close();
  }
});

it("measures each native item relative to its own PCM inside one response", async () => {
  const fixture = createRealtimePlaybackFixture();
  try {
    fixture.callbacks.onAudio(Buffer.alloc(9_600), { itemId: "first" });
    fixture.callbacks.onAudio(Buffer.alloc(48_000), { itemId: "second" });
    await fixture.voiceSdk.entersState(
      fixture.player,
      fixture.voiceSdk.AudioPlayerStatus.Playing,
      3_000,
    );
    const state = fixture.player.state;
    if (state.status === fixture.voiceSdk.AudioPlayerStatus.Idle) {
      throw new Error("expected response playback");
    }
    await vi.waitFor(() => expect(state.resource.playbackDuration).toBeGreaterThanOrEqual(300));
    const expected = [
      { itemId: "first", audioEndMs: 200 },
      { itemId: "second", audioEndMs: state.resource.playbackDuration - 200 },
    ];
    expect(fixture.callbacks.getPlaybackState?.()).toEqual(expected);
    expect(fixture.callbacks.getPlaybackState?.()).toEqual(expected);
    fixture.callbacks.onResponseDone?.({ status: "completed" });
    expect(fixture.callbacks.getPlaybackState?.()).toEqual([expected[1]]);
  } finally {
    fixture.close();
  }
});

it.each(["resumed", "next-item"])(
  "retains native item order and progress after starvation before %s",
  async (nextItemId) => {
    const fixture = createRealtimePlaybackFixture();
    try {
      fixture.callbacks.onAudio(Buffer.alloc(24_000), { itemId: "resumed" });
      await fixture.voiceSdk.entersState(
        fixture.player,
        fixture.voiceSdk.AudioPlayerStatus.Idle,
        4_000,
      );
      expect(fixture.callbacks.getPlaybackState?.()).toEqual([
        { itemId: "resumed", audioEndMs: 500 },
      ]);
      expect(fixture.roomPlayer.isActive()).toBe(true);
      fixture.callbacks.onAudio(Buffer.alloc(24_000), { itemId: nextItemId });
      await fixture.voiceSdk.entersState(
        fixture.player,
        fixture.voiceSdk.AudioPlayerStatus.Playing,
        3_000,
      );
      const state = fixture.player.state;
      if (state.status === fixture.voiceSdk.AudioPlayerStatus.Idle) {
        throw new Error("expected resumed native item");
      }
      const resumed = nextItemId === "resumed";
      expect(fixture.callbacks.getPlaybackState?.()).toEqual([
        { itemId: "resumed", audioEndMs: 500 + (resumed ? state.resource.playbackDuration : 0) },
        ...(resumed ? [] : [{ itemId: nextItemId, audioEndMs: state.resource.playbackDuration }]),
      ]);
      fixture.callbacks.onResponseDone?.({ status: "completed" });
      expect(fixture.callbacks.getPlaybackState?.()).toEqual([
        { itemId: nextItemId, audioEndMs: (resumed ? 500 : 0) + state.resource.playbackDuration },
      ]);
      await fixture.voiceSdk.entersState(
        fixture.player,
        fixture.voiceSdk.AudioPlayerStatus.Idle,
        3_000,
      );
      fixture.callbacks.onEvent?.({
        direction: "server",
        type: "response.created",
        responseId: "pending",
      });
      expect(fixture.callbacks.getPlaybackState?.()).toEqual([]);
      fixture.playback.speakControlResult("Stopped.");
      expect(fixture.cancel).toHaveBeenCalledOnce();
      expect(fixture.callbacks.getPlaybackState?.()).toEqual([]);
    } finally {
      fixture.close();
    }
  },
);

it("plays every frame of a burst through the real Opus encoder before releasing queued speech", async () => {
  const fixture = createRealtimePlaybackFixture();
  const queued = fixture.createLane();
  const {
    playback,
    player,
    voiceSdk,
    cancel,
    stop,
    stopTerminally,
    onTerminalError,
    onPlayerError,
  } = fixture;
  try {
    playback.enqueueExactSpeechMessage("first answer");
    // Seventeen 400 ms provider chunks exceed the PCM stream's normal backpressure threshold.
    const pcm = Buffer.alloc(24_000 * 2 * 0.4);
    for (let sample = 0; sample < pcm.length / 2; sample += 1) {
      pcm.writeInt16LE(
        Math.round(8_000 * Math.sin((sample * 2 * Math.PI * 440) / 24_000)),
        sample * 2,
      );
    }
    for (let chunk = 0; chunk < 17; chunk += 1) {
      playback.sendOutputAudio(pcm);
    }
    playback.enqueueExactSpeechMessage("second answer");
    const state = player.state;
    if (state.status === voiceSdk.AudioPlayerStatus.Idle) {
      throw new Error("Discord discarded the burst before playback could drain");
    }
    const resource = state.resource;
    const encoderFinished = once(resource.playStream, "finish");
    queued.playback.sendOutputAudio(Buffer.alloc(9_600));
    queued.playback.handleResponseDone({ status: "completed" });

    playback.handleResponseDone({ status: "completed" });
    await encoderFinished;

    // PCM encoding can finish while the Discord resource still has audible frames to play.
    expect(player.state.status).not.toBe(voiceSdk.AudioPlayerStatus.Idle);
    expect(playback.retainedExactSpeechTexts()).toEqual(["first answer", "second answer"]);
    await voiceSdk.entersState(player, voiceSdk.AudioPlayerStatus.Idle, 12_000);

    // The real AudioResource counts source packets only, excluding its silence padding.
    expect(resource.playbackDuration).toBe(6_800);
    expect(playback.retainedExactSpeechTexts()).toEqual(["second answer"]);
    expect(playback.isOutputAudioActive()).toBe(false);
    const queuedState = player.state;
    if (queuedState.status === voiceSdk.AudioPlayerStatus.Idle) {
      throw new Error("expected the queued speaker after the long response");
    }
    const queuedResource = queuedState.resource;
    await voiceSdk.entersState(player, voiceSdk.AudioPlayerStatus.Idle, 3_000);
    expect(queuedResource.playbackDuration).toBe(200);
    expect(cancel).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(stopTerminally).not.toHaveBeenCalled();
    expect(onTerminalError).not.toHaveBeenCalled();
    expect(onPlayerError).not.toHaveBeenCalled();
  } finally {
    fixture.close();
  }
}, 15_000);

it.each(["starvation", "encoder-error"] as const)(
  "keeps the provider response lifetime independent of %s Idle",
  async (ending) => {
    const fixture = createRealtimePlaybackFixture();
    const play = vi.spyOn(fixture.player, "play");
    try {
      fixture.playback.enqueueExactSpeechMessage("first answer");
      fixture.playback.enqueueExactSpeechMessage("queued answer");
      fixture.callbacks.onAudio(Buffer.alloc(24_000));
      await fixture.voiceSdk.entersState(
        fixture.player,
        fixture.voiceSdk.AudioPlayerStatus.Playing,
        3_000,
      );
      const firstState = fixture.player.state;
      if (firstState.status === fixture.voiceSdk.AudioPlayerStatus.Idle) {
        throw new Error("expected first response audio");
      }
      const first = firstState.resource;
      const firstIdle = new Promise<void>((resolve) => {
        fixture.player.once(fixture.voiceSdk.AudioPlayerStatus.Idle, () => resolve());
      });
      if (ending === "encoder-error") {
        first.playStream.destroy(new Error("synthetic encoder failure"));
      }
      await firstIdle;
      expect(fixture.onPlayerError).toHaveBeenCalledTimes(ending === "encoder-error" ? 1 : 0);
      if (ending === "starvation") {
        expect(first.playbackDuration).toBe(500);
      }
      expect(fixture.sendUserMessage.mock.calls).toEqual([["first answer"]]);
      fixture.callbacks.onAudio(Buffer.alloc(9_600));
      fixture.callbacks.onResponseDone?.({ status: "completed" });

      if (ending === "starvation") {
        expect(
          play,
          "later PCM in the same provider response must resume after normal starvation",
        ).toHaveBeenCalledTimes(2);
        const resumed = fixture.player.state;
        if (resumed.status === fixture.voiceSdk.AudioPlayerStatus.Idle) {
          throw new Error("same provider response did not resume");
        }
        const resource = resumed.resource;
        expect(fixture.sendUserMessage.mock.calls).toEqual([["first answer"]]);
        await fixture.voiceSdk.entersState(
          fixture.player,
          fixture.voiceSdk.AudioPlayerStatus.Idle,
          3_000,
        );
        expect(resource.playbackDuration).toBe(200);
      } else {
        expect(
          play,
          "an encoder failure must discard the rest of that response",
        ).toHaveBeenCalledOnce();
      }
      expect(fixture.sendUserMessage.mock.calls).toEqual([["first answer"], ["queued answer"]]);
      fixture.callbacks.onAudio(Buffer.alloc(9_600));
      fixture.callbacks.onResponseDone?.({ status: "completed" });
      await fixture.voiceSdk.entersState(
        fixture.player,
        fixture.voiceSdk.AudioPlayerStatus.Idle,
        3_000,
      );
      expect(play).toHaveBeenCalledTimes(ending === "starvation" ? 3 : 2);
    } finally {
      play.mockRestore();
      fixture.close();
    }
  },
);

it.each(["clear", "close"] as const)(
  "does not stop the current speaker when a queued lane is %s",
  async (action) => {
    const fixture = createRealtimePlaybackFixture();
    const queued = fixture.createLane();
    const { playback, player, voiceSdk } = fixture;
    try {
      playback.sendOutputAudio(Buffer.alloc(24_000));
      playback.handleResponseDone({ status: "completed" });
      const state = player.state;
      if (state.status === voiceSdk.AudioPlayerStatus.Idle) {
        throw new Error("expected current speaker playback");
      }
      const resource = state.resource;
      queued.playback.sendOutputAudio(Buffer.alloc(24_000));
      queued.playback.handleResponseDone({ status: "completed" });
      queued.playback.beginResponse();
      queued.playback.sendOutputAudio(Buffer.alloc(24_000));
      queued.playback.handleResponseDone({ status: "completed" });
      if (action === "clear") {
        queued.playback.clearOutputAudio("provider-clear");
      } else {
        queued.close();
      }
      expect(player.state).toBe(state);
      expect(fixture.stop).not.toHaveBeenCalled();
      await voiceSdk.entersState(player, voiceSdk.AudioPlayerStatus.Idle, 3_000);
      expect(resource.playbackDuration).toBe(500);
      expect(queued.playback.isOutputAudioActive()).toBe(false);
    } finally {
      fixture.close();
    }
  },
);

it("does not deliver a cancelled lane's Idle or late terminal to its replacement", async () => {
  const fixture = createRealtimePlaybackFixture();
  const next = fixture.createLane();
  const { playback: first, player, voiceSdk, roomPlayer } = fixture;
  try {
    first.enqueueExactSpeechMessage("first answer");
    first.sendOutputAudio(Buffer.alloc(24_000));
    next.playback.enqueueExactSpeechMessage("next answer");
    next.playback.sendOutputAudio(Buffer.alloc(24_000));
    next.playback.handleResponseDone({ status: "completed" });
    roomPlayer.handleBargeIn("new speaker");
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(next.cancel).not.toHaveBeenCalled();

    first.clearOutputAudio("provider-clear");
    const nextState = player.state;
    if (nextState.status === voiceSdk.AudioPlayerStatus.Idle) {
      throw new Error("cancelled Idle retired the next speaker");
    }
    expect(next.playback.retainedExactSpeechTexts()).toEqual(["next answer"]);
    first.handleResponseDone({ status: "cancelled" });
    expect(player.state).toBe(nextState);
    roomPlayer.handleBargeIn("another speaker");
    expect(next.cancel).toHaveBeenCalledOnce();
    await voiceSdk.entersState(player, voiceSdk.AudioPlayerStatus.Idle, 3_000);
    expect(nextState.resource.playbackDuration).toBe(500);
    expect(next.playback.retainedExactSpeechTexts()).toEqual([]);
  } finally {
    fixture.close();
  }
});

it("retires the room queue before stopping its current player", () => {
  const fixture = createRealtimePlaybackFixture();
  const queued = fixture.createLane();
  const play = vi.spyOn(fixture.player, "play");
  try {
    fixture.playback.sendOutputAudio(Buffer.alloc(24_000));
    fixture.playback.handleResponseDone({ status: "completed" });
    queued.playback.sendOutputAudio(Buffer.alloc(24_000));
    queued.playback.handleResponseDone({ status: "completed" });
    fixture.close();
    fixture.playback.handleResponseDone({ status: "cancelled" });
    queued.playback.sendOutputAudio(Buffer.alloc(24_000));
    expect(fixture.player.state.status).toBe(fixture.voiceSdk.AudioPlayerStatus.Idle);
    expect(play).toHaveBeenCalledOnce();
    expect(fixture.roomPlayer.isActive()).toBe(false);
  } finally {
    if (fixture.player.state.status !== fixture.voiceSdk.AudioPlayerStatus.Idle) {
      fixture.close();
    }
    play.mockRestore();
  }
});

it("clears every speaker's pending speech before speaking a room control result", () => {
  const fixture = createRealtimePlaybackFixture();
  const control = fixture.createLane();
  const queued = fixture.createLane();
  try {
    fixture.playback.enqueueExactSpeechMessage("active answer");
    fixture.playback.sendOutputAudio(Buffer.alloc(24_000));
    queued.playback.enqueueExactSpeechMessage("queued answer");
    queued.playback.enqueueExactSpeechMessage("later answer");
    queued.playback.sendOutputAudio(Buffer.alloc(24_000));
    queued.playback.handleResponseDone({ status: "completed" });

    control.playback.speakControlResult("Stopped.");
    expect(fixture.playback.retainedExactSpeechTexts()).toEqual([]);
    expect(queued.playback.retainedExactSpeechTexts()).toEqual([]);
    expect(fixture.playback.isOutputAudioActive()).toBe(false);
    expect(queued.playback.isOutputAudioActive()).toBe(false);
    expect(control.playback.retainedExactSpeechTexts()).toEqual(["Stopped."]);
    expect(fixture.player.state.status).toBe(fixture.voiceSdk.AudioPlayerStatus.Idle);
  } finally {
    fixture.close();
  }
});

it.each(["pending", "playing"] as const)(
  "interrupts a %s response for room control without interrupting an idle speaker's heard reply",
  async (phase) => {
    const fixture = createRealtimePlaybackFixture();
    const active = fixture.createLane();
    try {
      fixture.playback.enqueueExactSpeechMessage("already heard");
      fixture.callbacks.onAudio(Buffer.alloc(24_000));
      fixture.callbacks.onResponseDone?.({ status: "completed" });
      await fixture.voiceSdk.entersState(
        fixture.player,
        fixture.voiceSdk.AudioPlayerStatus.Idle,
        3_000,
      );

      active.playback.enqueueExactSpeechMessage("active answer");
      active.playback.enqueueExactSpeechMessage("old queued answer");
      if (phase === "playing") {
        active.callbacks.onAudio(Buffer.alloc(24_000));
        await fixture.voiceSdk.entersState(
          fixture.player,
          fixture.voiceSdk.AudioPlayerStatus.Playing,
          3_000,
        );
      }
      active.playback.speakControlResult("Stopped.");
      expect(fixture.cancel).not.toHaveBeenCalled();
      expect(active.cancel).toHaveBeenCalledOnce();
      expect(active.sendUserMessage.mock.calls).toEqual([["active answer"]]);
      active.callbacks.onResponseDone?.({ status: "completed" });
      expect(active.sendUserMessage.mock.calls).toEqual([["active answer"], ["Stopped."]]);
      active.callbacks.onAudio(Buffer.alloc(9_600));
      active.callbacks.onResponseDone?.({ status: "completed" });
      const state = fixture.player.state;
      if (state.status === fixture.voiceSdk.AudioPlayerStatus.Idle) {
        throw new Error("expected the room control confirmation");
      }
      await fixture.voiceSdk.entersState(
        fixture.player,
        fixture.voiceSdk.AudioPlayerStatus.Idle,
        3_000,
      );
      expect(state.resource.playbackDuration).toBe(200);
      expect(fixture.cancel).not.toHaveBeenCalled();
    } finally {
      fixture.close();
    }
  },
);

it("routes room interruption to preroll audio before the physical player starts", () => {
  const fixture = createRealtimePlaybackFixture();
  try {
    fixture.playback.sendOutputAudio(Buffer.alloc(480));
    expect(fixture.player.state.status).toBe(fixture.voiceSdk.AudioPlayerStatus.Idle);
    expect(fixture.roomPlayer.isActive()).toBe(true);
    fixture.roomPlayer.handleBargeIn("speaker-start");
    expect(fixture.cancel).toHaveBeenCalledOnce();
  } finally {
    fixture.close();
  }
});

it("reports player startup failure and lets another speaker play", async () => {
  const fixture = createRealtimePlaybackFixture();
  const next = fixture.createLane();
  const failure = new Error("synthetic playback startup failure");
  const startup = vi.spyOn(fixture.player, "play");
  startup.mockImplementationOnce(() => {
    throw failure;
  });
  try {
    expect(() => fixture.playback.sendOutputAudio(Buffer.alloc(24_000))).not.toThrow();
    expect(fixture.onTerminalError).toHaveBeenCalledWith(failure);
    expect(fixture.stopTerminally).toHaveBeenCalledOnce();
    next.playback.sendOutputAudio(Buffer.alloc(24_000));
    next.playback.handleResponseDone({ status: "completed" });
    const state = fixture.player.state;
    if (state.status === fixture.voiceSdk.AudioPlayerStatus.Idle) {
      throw new Error("failed source retained the room player");
    }
    await fixture.voiceSdk.entersState(
      fixture.player,
      fixture.voiceSdk.AudioPlayerStatus.Idle,
      3_000,
    );
    expect(state.resource.playbackDuration).toBe(500);
  } finally {
    fixture.close();
    startup.mockRestore();
  }
});

it.each(["clear", "unsupported"] as const)(
  "keeps interrupted audio silent until terminal when provider interruption is %s",
  async (interruption) => {
    const fixture = createRealtimePlaybackFixture();
    const lane = fixture.createLane(interruption);
    const play = vi.spyOn(fixture.player, "play");
    try {
      lane.callbacks.onAudio(Buffer.alloc(24_000));
      fixture.roomPlayer.handleBargeIn("other-speaker");
      expect(fixture.player.state.status).toBe(fixture.voiceSdk.AudioPlayerStatus.Idle);
      lane.callbacks.onAudio(Buffer.alloc(24_000));
      expect(play).toHaveBeenCalledOnce();

      lane.callbacks.onResponseDone?.({ status: "completed" });
      lane.callbacks.onAudio(Buffer.alloc(24_000));
      lane.callbacks.onResponseDone?.({ status: "completed" });
      const state = fixture.player.state;
      if (state.status === fixture.voiceSdk.AudioPlayerStatus.Idle) {
        throw new Error("interruption suppressed the next response");
      }
      await fixture.voiceSdk.entersState(
        fixture.player,
        fixture.voiceSdk.AudioPlayerStatus.Idle,
        3_000,
      );
      expect(state.resource.playbackDuration).toBe(500);
      expect(play).toHaveBeenCalledTimes(2);
    } finally {
      fixture.close();
      play.mockRestore();
    }
  },
);

it("does not let a clear after response completion silence the next response", async () => {
  const fixture = createRealtimePlaybackFixture();
  try {
    fixture.callbacks.onAudio(Buffer.alloc(24_000));
    fixture.callbacks.onResponseDone?.({ status: "completed" });
    await fixture.voiceSdk.entersState(
      fixture.player,
      fixture.voiceSdk.AudioPlayerStatus.Idle,
      3_000,
    );
    fixture.callbacks.onClearAudio();
    fixture.callbacks.onAudio(Buffer.alloc(24_000));
    fixture.callbacks.onResponseDone?.({ status: "completed" });
    const state = fixture.player.state;
    if (state.status === fixture.voiceSdk.AudioPlayerStatus.Idle) {
      throw new Error("late clear suppressed the next response");
    }
    await fixture.voiceSdk.entersState(
      fixture.player,
      fixture.voiceSdk.AudioPlayerStatus.Idle,
      3_000,
    );
    expect(state.resource.playbackDuration).toBe(500);
  } finally {
    fixture.close();
  }
});

it.each([
  { source: "same", admission: "exact speech" },
  { source: "another", admission: "exact speech" },
  { source: "same", admission: "provider response" },
  { source: "another", admission: "provider response" },
] as const)(
  "discards pending $admission audio when $source speaker controls the room",
  async ({ source, admission }) => {
    const fixture = createRealtimePlaybackFixture();
    const controller = source === "same" ? fixture : fixture.createLane();
    const play = vi.spyOn(fixture.player, "play");
    try {
      const nativeResponse = { direction: "server", type: "response.created" } as const;
      if (admission === "exact speech") {
        fixture.playback.enqueueExactSpeechMessage("old answer");
      } else {
        fixture.callbacks.onEvent?.(nativeResponse);
      }
      controller.playback.speakControlResult("Stopped.");
      expect(fixture.sendUserMessage.mock.calls).toEqual(
        admission === "exact speech" ? [["old answer"]] : [],
      );
      // A delayed or repeated native announcement cannot reopen cancelled output.
      fixture.callbacks.onEvent?.(nativeResponse);
      fixture.callbacks.onAudio(Buffer.alloc(24_000));
      expect(play).not.toHaveBeenCalled();

      fixture.callbacks.onResponseDone?.({ status: "completed" });
      expect(controller.sendUserMessage).toHaveBeenLastCalledWith("Stopped.");
      controller.callbacks.onAudio(Buffer.alloc(24_000));
      controller.callbacks.onResponseDone?.({ status: "completed" });
      const state = fixture.player.state;
      if (state.status === fixture.voiceSdk.AudioPlayerStatus.Idle) {
        throw new Error("expected the control response after the cancelled response ended");
      }
      await fixture.voiceSdk.entersState(
        fixture.player,
        fixture.voiceSdk.AudioPlayerStatus.Idle,
        3_000,
      );
      expect(state.resource.playbackDuration).toBe(500);
      expect(play).toHaveBeenCalledOnce();
    } finally {
      fixture.close();
      play.mockRestore();
    }
  },
);

it("queues exact speech behind a native response that has not produced audio", async () => {
  const fixture = createRealtimePlaybackFixture();
  try {
    fixture.callbacks.onEvent?.({ direction: "server", type: "response.created" });
    fixture.playback.enqueueExactSpeechMessage("next answer");
    expect(fixture.sendUserMessage).not.toHaveBeenCalled();
    fixture.callbacks.onResponseDone?.({ status: "completed" });
    expect(fixture.sendUserMessage.mock.calls).toEqual([["next answer"]]);
    fixture.callbacks.onAudio(Buffer.alloc(24_000));
    fixture.callbacks.onResponseDone?.({ status: "completed" });
    const state = fixture.player.state;
    if (state.status === fixture.voiceSdk.AudioPlayerStatus.Idle) {
      throw new Error("expected exact speech after the native response ended");
    }
    await fixture.voiceSdk.entersState(
      fixture.player,
      fixture.voiceSdk.AudioPlayerStatus.Idle,
      3_000,
    );
    expect(state.resource.playbackDuration).toBe(500);
  } finally {
    fixture.close();
  }
});

it("does not apply a cancelled terminal to replacement audio delivered during the queued send", async () => {
  const fixture = createRealtimePlaybackFixture();
  try {
    fixture.playback.enqueueExactSpeechMessage("old answer");
    fixture.playback.speakControlResult("Stopped.");
    fixture.sendUserMessage.mockImplementationOnce(() =>
      fixture.callbacks.onAudio(Buffer.alloc(24_000)),
    );
    fixture.callbacks.onResponseDone?.({ status: "cancelled" });
    const state = fixture.player.state;
    if (state.status === fixture.voiceSdk.AudioPlayerStatus.Idle) {
      throw new Error("the old terminal discarded the replacement audio");
    }
    fixture.callbacks.onAudio(Buffer.alloc(24_000));
    fixture.callbacks.onResponseDone?.({ status: "completed" });
    await fixture.voiceSdk.entersState(
      fixture.player,
      fixture.voiceSdk.AudioPlayerStatus.Idle,
      3_000,
    );
    expect(state.resource.playbackDuration).toBe(1_000);
  } finally {
    fixture.close();
  }
});

it.each(["before grant", "during playback"] as const)(
  "plays a native continuation begun %s without losing its later tail",
  async (timing) => {
    const fixture = createRealtimePlaybackFixture();
    const queued = fixture.createLane();
    const play = vi.spyOn(fixture.player, "play");
    try {
      fixture.callbacks.onAudio(Buffer.alloc(24_000));
      fixture.callbacks.onResponseDone?.({ status: "completed" });
      queued.callbacks.onEvent?.({
        direction: "server",
        type: "response.created",
        responseId: "first",
      });
      queued.callbacks.onAudio(Buffer.alloc(48_000));
      queued.callbacks.onResponseDone?.({ status: "completed", responseId: "first" });
      if (timing === "during playback") {
        await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(2));
      }
      queued.callbacks.onEvent?.({
        direction: "server",
        type: "response.created",
        responseId: "continuation",
      });
      queued.callbacks.onAudio(Buffer.alloc(9_600));
      queued.playback.enqueueExactSpeechMessage("after continuation");
      expect(queued.sendUserMessage).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(2));
      queued.callbacks.onAudio(Buffer.alloc(4_800));
      queued.callbacks.onResponseDone?.({ status: "completed", responseId: "continuation" });

      await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(3), { timeout: 3_000 });
      expect(queued.sendUserMessage).not.toHaveBeenCalled();
      await fixture.voiceSdk.entersState(
        fixture.player,
        fixture.voiceSdk.AudioPlayerStatus.Idle,
        3_000,
      );
      expect(play.mock.calls.map(([resource]) => resource.playbackDuration)).toEqual([
        500, 1_000, 300,
      ]);
      expect(queued.sendUserMessage.mock.calls).toEqual([["after continuation"]]);
      expect(queued.playback.isOutputAudioActive()).toBe(false);
    } finally {
      fixture.close();
      play.mockRestore();
    }
  },
);

it("does not replay heard exact speech when a later native response has no audio at reconnect", async () => {
  const fixture = createRealtimePlaybackFixture();
  try {
    fixture.playback.enqueueExactSpeechMessage("already heard");
    fixture.callbacks.onAudio(Buffer.alloc(24_000));
    fixture.callbacks.onResponseDone?.({ status: "completed" });
    fixture.callbacks.onEvent?.({
      direction: "server",
      type: "response.created",
      responseId: "pending",
    });
    await fixture.voiceSdk.entersState(
      fixture.player,
      fixture.voiceSdk.AudioPlayerStatus.Idle,
      3_000,
    );

    fixture.playback.resetProviderContinuity("provider-reconnect");
    fixture.playback.drainQueuedExactSpeechMessages("provider-ready");
    expect(fixture.sendUserMessage.mock.calls).toEqual([["already heard"]]);
  } finally {
    fixture.close();
  }
});

it.each([
  { budget: "response count", responses: 33, bytes: 480 },
  { budget: "PCM bytes", responses: 3, bytes: 2_000_000 },
])("bounds retained $budget across a speaker's queued native responses", ({ responses, bytes }) => {
  const fixture = createRealtimePlaybackFixture();
  const queued = fixture.createLane();
  try {
    fixture.callbacks.onAudio(Buffer.alloc(24_000));
    fixture.callbacks.onResponseDone?.({ status: "completed" });
    const current = fixture.player.state;
    for (let index = 0; index < responses; index += 1) {
      const responseId = `queued-${index}`;
      queued.callbacks.onEvent?.({ direction: "server", type: "response.created", responseId });
      queued.callbacks.onAudio(Buffer.alloc(bytes));
      queued.callbacks.onResponseDone?.({ status: "completed", responseId });
    }
    expect(queued.stopTerminally).toHaveBeenCalledOnce();
    expect(queued.onTerminalError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("audio playback overflow") }),
    );
    expect(queued.playback.isOutputAudioActive()).toBe(false);
    expect(fixture.player.state).toBe(current);
    expect(fixture.stop).not.toHaveBeenCalled();
  } finally {
    fixture.close();
  }
});

it("keeps a native continuation when its completed predecessor fails during playback", async () => {
  const fixture = createRealtimePlaybackFixture();
  const queued = fixture.createLane();
  const play = vi.spyOn(fixture.player, "play");
  try {
    fixture.callbacks.onAudio(Buffer.alloc(24_000));
    fixture.callbacks.onResponseDone?.({ status: "completed" });
    queued.callbacks.onEvent?.({
      direction: "server",
      type: "response.created",
      responseId: "first",
    });
    queued.callbacks.onAudio(Buffer.alloc(48_000));
    queued.callbacks.onResponseDone?.({ status: "completed", responseId: "first" });
    queued.callbacks.onEvent?.({
      direction: "server",
      type: "response.created",
      responseId: "continuation",
    });
    queued.callbacks.onAudio(Buffer.alloc(9_600));
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(2));
    const previous = fixture.player.state;
    if (previous.status === fixture.voiceSdk.AudioPlayerStatus.Idle) {
      throw new Error("expected predecessor playback");
    }
    previous.resource.playStream.destroy(new Error("synthetic predecessor failure"));
    await vi.waitFor(() => expect(fixture.onPlayerError).toHaveBeenCalledOnce());
    queued.callbacks.onAudio(Buffer.alloc(4_800));
    queued.callbacks.onResponseDone?.({ status: "completed", responseId: "continuation" });
    expect(play).toHaveBeenCalledTimes(3);
    await fixture.voiceSdk.entersState(
      fixture.player,
      fixture.voiceSdk.AudioPlayerStatus.Idle,
      3_000,
    );
    expect(play.mock.calls[2]?.[0].playbackDuration).toBe(300);
    expect(queued.onTerminalError).not.toHaveBeenCalled();
  } finally {
    fixture.close();
    play.mockRestore();
  }
});

it("plays overlapping speaker responses in order without replacing another lane's resource", async () => {
  const fixture = createRealtimePlaybackFixture();
  const second = fixture.createLane();
  const { playback: first, player, voiceSdk } = fixture;
  try {
    first.enqueueExactSpeechMessage("first answer");
    first.sendOutputAudio(Buffer.alloc(24_000));
    first.handleResponseDone({ status: "completed" });
    const firstState = player.state;
    if (firstState.status === voiceSdk.AudioPlayerStatus.Idle) {
      throw new Error("expected first speaker playback");
    }
    const firstResource = firstState.resource;
    second.playback.enqueueExactSpeechMessage("second answer");
    second.playback.sendOutputAudio(Buffer.alloc(24_000));
    second.playback.handleResponseDone({ status: "completed" });

    const currentState = player.state;
    expect(currentState.status).not.toBe(voiceSdk.AudioPlayerStatus.Idle);
    if (currentState.status === voiceSdk.AudioPlayerStatus.Idle) {
      throw new Error("speaker overlap stopped playback");
    }
    expect(currentState.resource).toBe(firstResource);
    expect(second.playback.retainedExactSpeechTexts()).toEqual(["second answer"]);

    await vi.waitFor(() => {
      const state = player.state;
      expect(state.status).not.toBe(voiceSdk.AudioPlayerStatus.Idle);
      if (state.status !== voiceSdk.AudioPlayerStatus.Idle) {
        expect(state.resource).not.toBe(firstResource);
      }
    });
    const secondState = player.state;
    if (secondState.status === voiceSdk.AudioPlayerStatus.Idle) {
      throw new Error("expected second speaker playback");
    }
    const secondResource = secondState.resource;
    await voiceSdk.entersState(player, voiceSdk.AudioPlayerStatus.Idle, 3_000);
    expect(firstResource.playbackDuration).toBe(500);
    expect(secondResource.playbackDuration).toBe(500);
    expect(first.retainedExactSpeechTexts()).toEqual([]);
    expect(second.playback.retainedExactSpeechTexts()).toEqual([]);
    expect(fixture.onPlayerError).not.toHaveBeenCalled();
  } finally {
    fixture.close();
  }
});
