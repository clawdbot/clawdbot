import { Buffer } from "node:buffer";
import { truncateUtf8Suffix } from "../../utils/utf8-truncate.js";

export const CLI_RUNNER_OUTPUT_TAIL_BYTES = 64 * 1024;

export interface CliOutputTail {
  tail: string;
  droppedBytes: number;
}

export function appendCliOutputTail(tail: string, chunk: string): CliOutputTail {
  const combined = `${tail}${chunk}`;
  const truncated = truncateUtf8Suffix(combined, CLI_RUNNER_OUTPUT_TAIL_BYTES);
  return {
    tail: truncated,
    droppedBytes: Buffer.byteLength(combined, "utf8") - Buffer.byteLength(truncated, "utf8"),
  };
}

/** Labels lost stderr before the retained diagnostic so it cannot look complete. */
export function formatCliStderrTail(tail: string, droppedBytes: number): string {
  const diagnostic = tail.trim();
  if (droppedBytes === 0) {
    return diagnostic;
  }
  const note = `[${droppedBytes} UTF-8 bytes of earlier stderr discarded at the ${CLI_RUNNER_OUTPUT_TAIL_BYTES}-byte retention cap]`;
  return diagnostic ? `${note}\n${diagnostic}` : note;
}
