const DOUBAO_MAX_SPEAKABLE_CHARACTERS = 1_800;

export type Pcm24kTo16kResamplerState = {
  pending: Buffer;
  sourcePosition: number;
};

function clampPcm16(value: number): number {
  return Math.max(-32_768, Math.min(32_767, Math.round(value)));
}

/** Exact streaming 3:2 conversion for the relay's PCM16 mono 24 kHz contract. */
export function resamplePcm16Mono24kTo16k(input: Buffer, state: Pcm24kTo16kResamplerState): Buffer {
  const combined = state.pending.byteLength > 0 ? Buffer.concat([state.pending, input]) : input;
  const completeGroupBytes = Math.floor(combined.byteLength / 6) * 6;
  state.pending = Buffer.from(combined.subarray(completeGroupBytes));
  if (completeGroupBytes === 0) {
    return Buffer.alloc(0);
  }

  const output = Buffer.allocUnsafe((completeGroupBytes / 6) * 4);
  let outputOffset = 0;
  for (let offset = 0; offset < completeGroupBytes; offset += 6) {
    const first = combined.readInt16LE(offset);
    const second = combined.readInt16LE(offset + 2);
    const third = combined.readInt16LE(offset + 4);
    output.writeInt16LE(first, outputOffset);
    output.writeInt16LE(clampPcm16((second + third) / 2), outputOffset + 2);
    outputOffset += 4;
    state.sourcePosition += 3;
  }
  return output;
}

export function truncateCharacters(value: string, max: number): string {
  return Array.from(value).slice(0, max).join("");
}

/** Removes OpenClaw's internal relay wrapper before sending text to Doubao TTS. */
export function extractDoubaoSpeakableMessage(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("Internal OpenClaw voice control result.")) {
    const status = trimmed.match(/^Status:\s*(.+)$/mu)?.[1]?.trim();
    if (status) {
      try {
        const decoded = JSON.parse(status) as unknown;
        if (typeof decoded === "string") {
          return truncateCharacters(decoded.trim(), DOUBAO_MAX_SPEAKABLE_CHARACTERS);
        }
      } catch {
        return truncateCharacters(status, DOUBAO_MAX_SPEAKABLE_CHARACTERS);
      }
    }
  }

  if (trimmed.startsWith("OpenClaw finished checking.")) {
    const separator = trimmed.indexOf("\n\n");
    if (separator >= 0) {
      return truncateCharacters(
        trimmed.slice(separator + 2).trim(),
        DOUBAO_MAX_SPEAKABLE_CHARACTERS,
      );
    }
  }

  if (trimmed.startsWith("OpenClaw is checking")) {
    return "我正在处理，请稍等。";
  }
  return truncateCharacters(trimmed, DOUBAO_MAX_SPEAKABLE_CHARACTERS);
}
