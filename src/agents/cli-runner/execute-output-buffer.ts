const CLI_RUNNER_OUTPUT_TAIL_BYTES = 64 * 1024;

export function appendCliOutputTail(tail: Buffer, chunk: string): Buffer {
  if (!chunk) {
    return tail;
  }
  const chunkBuffer = Buffer.from(chunk);
  if (chunkBuffer.byteLength >= CLI_RUNNER_OUTPUT_TAIL_BYTES) {
    return Buffer.from(chunkBuffer.subarray(chunkBuffer.byteLength - CLI_RUNNER_OUTPUT_TAIL_BYTES));
  }
  const next = Buffer.concat([tail, chunkBuffer], tail.byteLength + chunkBuffer.byteLength);
  if (next.byteLength <= CLI_RUNNER_OUTPUT_TAIL_BYTES) {
    return next;
  }
  return Buffer.from(next.subarray(next.byteLength - CLI_RUNNER_OUTPUT_TAIL_BYTES));
}
