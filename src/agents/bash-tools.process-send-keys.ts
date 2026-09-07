/**
 * Send-keys support for process-controlled PTY sessions.
 * Encodes symbolic keys, hex bytes, and literal input before writing to a
 * live process stdin.
 */
import type { ManagedRunStdin } from "../process/supervisor/types.js";
import type { ProcessSession } from "./bash-process-registry.js";
import { deriveSessionName } from "./bash-tools.shared.js";
import { encodeKeySequence, hasCursorModeSensitiveKeys } from "./pty-keys.js";
import type { AgentToolResult } from "./runtime/index.js";
import { textResult } from "./tools/tool-results.js";

function failText(text: string): AgentToolResult<unknown> {
  return textResult(text, { status: "failed", error: text });
}

export async function writeProcessStdin(stdin: ManagedRunStdin, data: string | Buffer) {
  await new Promise<void>((resolve, reject) => {
    stdin.write(data, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/** Encode and write requested key data into a running process session. */
export async function handleProcessSendKeys(params: {
  sessionId: string;
  session: ProcessSession;
  stdin: ManagedRunStdin;
  keys?: string[];
  hex?: string[];
  literal?: string;
}): Promise<AgentToolResult<unknown>> {
  const request = {
    keys: params.keys,
    hex: params.hex,
    literal: params.literal,
  };
  if (params.session.cursorKeyMode === "unknown" && hasCursorModeSensitiveKeys(request)) {
    // Arrow/keypad encodings depend on cursor key mode. Wait for startup output
    // to identify the mode before sending potentially wrong bytes.
    return failText(
      `Session ${params.sessionId} cursor key mode is not known yet. Poll or log until startup output appears, then retry send-keys.`,
    );
  }
  const cursorKeyMode =
    params.session.cursorKeyMode === "unknown" ? undefined : params.session.cursorKeyMode;
  const { data, warnings } = encodeKeySequence(request, cursorKeyMode);
  if (data.length === 0) {
    return failText("No key data provided.");
  }
  await writeProcessStdin(params.stdin, data);
  const text =
    `Sent ${data.length} bytes to session ${params.sessionId}.` +
    (warnings.length ? `\nWarnings:\n- ${warnings.join("\n- ")}` : "");
  return textResult(text, {
    status: "running",
    sessionId: params.sessionId,
    name: deriveSessionName(params.session.command),
  });
}
