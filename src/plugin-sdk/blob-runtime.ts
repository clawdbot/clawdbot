/** Use immediately in a Blob constructor, which snapshots this exact byte range. */
export function bufferToBlobPart(buffer: Buffer): Uint8Array<ArrayBuffer> {
  return buffer.buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : Uint8Array.from(buffer);
}
