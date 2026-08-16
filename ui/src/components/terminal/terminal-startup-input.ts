import { BoundedBuffer } from "../../../../src/shared/bounded-buffer.ts";
import type { TerminalConnection } from "./terminal-connection.ts";

const MAX_PENDING_INPUT_CHARS = 8 * 1024;
const TERMINAL_INPUT_DECODER = new TextDecoder();

export type StartupInputBuffer = BoundedBuffer<string>;

export function createTerminalStartupInput(
  connection: Pick<TerminalConnection, "input" | "resize">,
  getSessionId: () => string | undefined,
) {
  // Preserve a valid startup prefix: after one drop, all later chunks stay dropped.
  const buffer = new BoundedBuffer<string>(
    MAX_PENDING_INPUT_CHARS,
    { mode: "latch" },
    (data) => data.length,
  );
  return {
    buffer,
    onData: (bytes: Uint8Array) => {
      const data = TERMINAL_INPUT_DECODER.decode(bytes);
      const sessionId = getSessionId();
      if (sessionId) {
        void connection.input(sessionId, data);
      } else {
        buffer.push(data);
      }
    },
    onResize: ({ columns, rows }: { columns: number; rows: number }) => {
      const sessionId = getSessionId();
      if (sessionId) {
        void connection.resize(sessionId, columns, rows);
      }
    },
  };
}
