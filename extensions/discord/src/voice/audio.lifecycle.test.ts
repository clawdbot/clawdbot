import { once } from "node:events";
import type { OpusEncoderHandle } from "libopus-wasm";
import { beforeEach, expect, it, vi } from "vitest";

const { createEncoderMock } = vi.hoisted(() => ({ createEncoderMock: vi.fn() }));
vi.mock("libopus-wasm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("libopus-wasm")>()),
  createEncoder: createEncoderMock,
}));

import { createDiscordOpusEncodeStream } from "./audio.js";

beforeEach(() => createEncoderMock.mockReset());

it("releases an encoder acquired after playback was destroyed without encoding queued audio", async () => {
  const codec = await vi.importActual<typeof import("libopus-wasm")>("libopus-wasm");
  const encoder = await codec.createEncoder({ channels: 2, sampleRate: 48_000 });
  const encode = vi.spyOn(encoder, "encode");
  const free = vi.spyOn(encoder, "free");
  let resolveEncoder!: (encoder: OpusEncoderHandle) => void;
  createEncoderMock.mockReturnValueOnce(
    new Promise<OpusEncoderHandle>((resolve) => {
      resolveEncoder = resolve;
    }),
  );
  const stream = createDiscordOpusEncodeStream();
  try {
    stream.write(Buffer.alloc(960 * 2 * 2));
    await vi.waitFor(() => expect(createEncoderMock).toHaveBeenCalledOnce());
    const closed = once(stream, "close");
    stream.destroy();
    resolveEncoder(encoder);
    await closed;

    expect(free).toHaveBeenCalledOnce();
    expect(encode).not.toHaveBeenCalled();
  } finally {
    stream.destroy();
    encoder.free();
    vi.restoreAllMocks();
  }
});

it("reports encoder initialization failures without producing queued audio", async () => {
  const error = new Error("encoder initialization failed");
  createEncoderMock.mockRejectedValueOnce(error);
  const stream = createDiscordOpusEncodeStream();
  const errors: Error[] = [];
  stream.on("error", (err) => errors.push(err));
  const closed = new Promise<void>((resolve) => {
    stream.once("close", resolve);
  });
  stream.end(Buffer.alloc(960 * 2 * 2));
  await closed;

  expect(errors).toEqual([error]);
  expect(stream.read()).toBeNull();
});
