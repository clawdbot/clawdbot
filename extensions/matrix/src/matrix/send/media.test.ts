import { describe, expect, it } from "vitest";
import { resolveMediaDurationMs } from "./media.js";

const AIFC_SAMPLE_RATE = 44_100;
const AIFC_PACKET_COUNT = 441;

function buildAiffChunk(type: string, content: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32BE(content.length, 4);
  return Buffer.concat([header, content, ...(content.length % 2 ? [Buffer.alloc(1)] : [])]);
}

function buildAifcFixture(
  params: {
    channels?: number;
    codec?: string;
    decodedFrameCount?: boolean;
    malformedSoundData?: boolean;
  } = {},
): Buffer {
  const channels = params.channels ?? 1;
  const codec = params.codec ?? "ima4";
  const compressed = codec === "ima4";
  const samplesPerPacket = compressed ? 64 : 1;
  const bytesPerPacket = compressed ? channels * 34 : channels;
  const declaredFrameCount =
    params.decodedFrameCount || !compressed
      ? AIFC_PACKET_COUNT * samplesPerPacket
      : AIFC_PACKET_COUNT;
  const common = Buffer.alloc(22);
  common.writeUInt16BE(channels, 0);
  common.writeUInt32BE(declaredFrameCount, 2);
  common.writeUInt16BE(compressed ? 0 : 8, 6);
  common.writeUInt16BE(0x400e, 8);
  common.writeUInt16BE(AIFC_SAMPLE_RATE, 10);
  common.write(codec, 18, "ascii");

  const sound = Buffer.alloc(
    8 + AIFC_PACKET_COUNT * bytesPerPacket + (params.malformedSoundData ? 1 : 0),
  );
  const chunks = Buffer.concat([
    // Odd-sized chunks exercise the IFF padding rule before locating COMM.
    buildAiffChunk("JUNK", Buffer.from([0])),
    buildAiffChunk("COMM", common),
    buildAiffChunk("SSND", sound),
  ]);
  const form = Buffer.alloc(12);
  form.write("FORM", 0, "ascii");
  form.writeUInt32BE(chunks.length + 4, 4);
  form.write("AIFC", 8, "ascii");
  return Buffer.concat([form, chunks]);
}

describe("resolveMediaDurationMs", () => {
  it.each([1, 2])(
    "corrects Apple IMA4 packet-count durations for %i channel(s)",
    async (channels) => {
      await expect(
        resolveMediaDurationMs({
          buffer: buildAifcFixture({ channels }),
          contentType: "audio/aiff",
          fileName: "clip.aifc",
          kind: "audio",
        }),
      ).resolves.toBe(640);
    },
  );

  it("preserves IMA4 durations when COMM already contains decoded sample frames", async () => {
    await expect(
      resolveMediaDurationMs({
        buffer: buildAifcFixture({ decodedFrameCount: true }),
        contentType: "audio/aiff",
        fileName: "clip.aifc",
        kind: "audio",
      }),
    ).resolves.toBe(640);
  });

  it.each(["alaw", "ulaw"])("preserves non-IMA4 AIFC %s durations", async (codec) => {
    await expect(
      resolveMediaDurationMs({
        buffer: buildAifcFixture({ codec }),
        contentType: "audio/aiff",
        fileName: "clip.aifc",
        kind: "audio",
      }),
    ).resolves.toBe(10);
  });

  it("does not reinterpret malformed IMA4 sound data as complete packets", async () => {
    await expect(
      resolveMediaDurationMs({
        buffer: buildAifcFixture({ malformedSoundData: true }),
        contentType: "audio/aiff",
        fileName: "clip.aifc",
        kind: "audio",
      }),
    ).resolves.toBe(10);
  });
});
