import { expect, it } from "vitest";
import { createRealtimePlaybackFixture } from "./realtime-playback.integration.test-support.js";

it("keeps PCM marks truthful across repeated partial-frame underflows", async () => {
  const fixture = createRealtimePlaybackFixture();
  try {
    fixture.callbacks.onAudio(Buffer.alloc(24_480), { itemId: "resumed" });
    const state = fixture.player.state;
    if (state.status === fixture.voiceSdk.AudioPlayerStatus.Idle) {
      throw new Error("expected response resource");
    }
    const consumed: Array<{ opusMs: number; pcmMs: number | undefined }> = [];
    const recordProgress = () => {
      consumed.push({
        opusMs: state.resource.playbackDuration,
        pcmMs: fixture.callbacks.getPlaybackState?.()[0]?.audioEndMs,
      });
    };
    fixture.callbacks.onMark?.("first", () => {
      recordProgress();
      fixture.callbacks.onAudio(Buffer.alloc(24_480), { itemId: "resumed" });
      fixture.callbacks.onMark?.("second", () => {
        recordProgress();
        fixture.callbacks.onResponseDone?.({ status: "completed" });
      });
    });
    await fixture.voiceSdk.entersState(
      fixture.player,
      fixture.voiceSdk.AudioPlayerStatus.Idle,
      4_000,
    );
    expect(fixture.onTerminalError).not.toHaveBeenCalled();
    expect(consumed).toEqual([
      { opusMs: 520, pcmMs: 510 },
      { opusMs: 1_040, pcmMs: 1_020 },
    ]);
  } finally {
    fixture.close();
  }
});
