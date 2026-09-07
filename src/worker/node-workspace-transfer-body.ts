export async function* boundedWorkspaceTransferChunks(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): AsyncGenerator<Buffer> {
  let total = 0;
  for await (const value of body) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new Error("workspace transfer response exceeded its byte limit");
    }
    yield chunk;
  }
}

export async function readWorkspaceTransferBody(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of boundedWorkspaceTransferChunks(body, maxBytes)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
