import { afterEach, beforeEach, onTestFinished, vi } from "vitest";
import { RealtimeTalkInputController } from "./realtime-talk-input.ts";

export async function prepareRealtimeTalkTestInput(
  inputDeviceId?: string,
): Promise<RealtimeTalkInputController> {
  const input = new RealtimeTalkInputController(() => undefined);
  onTestFinished(() => input.stop());
  await input.open(inputDeviceId);
  return input;
}

export function useRealtimeTalkMicrophoneFixture(): void {
  beforeEach(() => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          const track = Object.assign(new EventTarget(), { stop: vi.fn() });
          return { getTracks: () => [track], getAudioTracks: () => [track] };
        }),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());
}
