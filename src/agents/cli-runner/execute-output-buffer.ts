import { truncateUtf8Suffix } from "../../utils/utf8-truncate.js";

const CLI_RUNNER_OUTPUT_TAIL_BYTES = 64 * 1024;

export function appendCliOutputTail(tail: string, chunk: string): string {
  return truncateUtf8Suffix(`${tail}${chunk}`, CLI_RUNNER_OUTPUT_TAIL_BYTES);
}
