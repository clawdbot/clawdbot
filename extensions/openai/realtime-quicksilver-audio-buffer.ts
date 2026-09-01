const RELAY_FRAME_SAMPLES = 480;
const MAX_PENDING_RELAY_FRAMES = 250;

export const OPENAI_QUICKSILVER_RELAY_FRAME_BYTES = RELAY_FRAME_SAMPLES * 2;
// One five-second tail spans peer startup and the connected media pump.
// Keeping the newest PCM bounds latency without changing policy at adoption.
const OPENAI_QUICKSILVER_MAX_PENDING_AUDIO_BYTES =
  OPENAI_QUICKSILVER_RELAY_FRAME_BYTES * MAX_PENDING_RELAY_FRAMES;

export class OpenAIQuicksilverPendingAudio {
  private storage: Buffer | undefined;
  private readOffset = 0;
  private pendingBytes = 0;

  get length(): number {
    return this.pendingBytes;
  }

  append(incoming: Buffer): void {
    const evenLength = incoming.length - (incoming.length % 2);
    if (evenLength === 0) {
      return;
    }

    // Capture owns its input only until the next callback; copy each retained sample
    // once into the circular tail instead of copying the entire history per frame.
    const retainedBytes = Math.min(evenLength, OPENAI_QUICKSILVER_MAX_PENDING_AUDIO_BYTES);
    const sourceOffset = evenLength - retainedBytes;
    const storage = (this.storage ??= Buffer.alloc(OPENAI_QUICKSILVER_MAX_PENDING_AUDIO_BYTES));
    const droppedBytes = Math.max(
      0,
      this.pendingBytes + retainedBytes - OPENAI_QUICKSILVER_MAX_PENDING_AUDIO_BYTES,
    );
    this.readOffset = (this.readOffset + droppedBytes) % OPENAI_QUICKSILVER_MAX_PENDING_AUDIO_BYTES;
    this.pendingBytes -= droppedBytes;

    const writeOffset =
      (this.readOffset + this.pendingBytes) % OPENAI_QUICKSILVER_MAX_PENDING_AUDIO_BYTES;
    const firstBytes = Math.min(
      retainedBytes,
      OPENAI_QUICKSILVER_MAX_PENDING_AUDIO_BYTES - writeOffset,
    );
    incoming.copy(storage, writeOffset, sourceOffset, sourceOffset + firstBytes);
    if (firstBytes < retainedBytes) {
      incoming.copy(storage, 0, sourceOffset + firstBytes, sourceOffset + retainedBytes);
    }
    this.pendingBytes += retainedBytes;
  }

  readInto(target: Buffer): number {
    const evenLength = target.length - (target.length % 2);
    const readBytes = Math.min(evenLength, this.pendingBytes);
    const storage = this.storage;
    if (readBytes === 0 || !storage) {
      return 0;
    }

    const firstBytes = Math.min(
      readBytes,
      OPENAI_QUICKSILVER_MAX_PENDING_AUDIO_BYTES - this.readOffset,
    );
    storage.copy(target, 0, this.readOffset, this.readOffset + firstBytes);
    if (firstBytes < readBytes) {
      storage.copy(target, firstBytes, 0, readBytes - firstBytes);
    }
    this.readOffset = (this.readOffset + readBytes) % OPENAI_QUICKSILVER_MAX_PENDING_AUDIO_BYTES;
    this.pendingBytes -= readBytes;
    if (this.pendingBytes === 0) {
      this.readOffset = 0;
    }
    return readBytes;
  }

  clear(): void {
    this.storage = undefined;
    this.readOffset = 0;
    this.pendingBytes = 0;
  }
}
