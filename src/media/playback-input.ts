type PositionedReader = {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
};

type PositionedWriter = {
  write(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number }>;
};

/** Copies only the admitted source length, probing one extra byte for growth. */
export async function copyPlaybackInputBounded(
  source: PositionedReader,
  target: PositionedWriter,
  expectedSize: number,
  maxBytes: number,
): Promise<void> {
  const maxReadBytes = Math.min(maxBytes + 1, expectedSize + 1);
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxReadBytes));
  let totalBytes = 0;
  while (totalBytes < maxReadBytes) {
    const { bytesRead } = await source.read(
      buffer,
      0,
      Math.min(buffer.length, maxReadBytes - totalBytes),
      totalBytes,
    );
    if (bytesRead === 0) {
      break;
    }
    if (totalBytes + bytesRead > maxBytes || totalBytes + bytesRead > expectedSize) {
      throw new Error("Playback source changed during bounded read");
    }
    let written = 0;
    while (written < bytesRead) {
      const { bytesWritten } = await target.write(
        buffer,
        written,
        bytesRead - written,
        totalBytes + written,
      );
      if (bytesWritten === 0) {
        throw new Error("Playback input staging write made no progress");
      }
      written += bytesWritten;
    }
    totalBytes += bytesRead;
  }
  if (totalBytes !== expectedSize) {
    throw new Error("Playback source changed during bounded read");
  }
}
