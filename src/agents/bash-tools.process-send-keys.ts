import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ProcessSession } from "./bash-process-registry.js";
import { deriveSessionName } from "./bash-tools.shared.js";
import { encodeKeySequence, hasCursorModeSensitiveKeys } from "./pty-keys.js";

export type WritableStdin = {
  write: (data: string, cb?: (err?: Error | null) => void) => void;
  end: () => void;
  destroyed?: boolean;
  writable?: boolean;
  writableEnded?: boolean;
  writableFinished?: boolean;
};

function failText(text: string): AgentToolResult<unknown> {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    details: { status: "failed" },
  };
}

async function writeToStdin(stdin: WritableStdin, data: string) {
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

export async function handleProcessSendKeys(params: {
  sessionId: string;
  session: ProcessSession;
  stdin: WritableStdin;
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
    return failText(
      `Session ${params.sessionId} cursor key mode is not known yet. Poll or log until startup output appears, then retry send-keys.`,
    );
  }
  const cursorKeyMode =
    params.session.cursorKeyMode === "unknown" ? undefined : params.session.cursorKeyMode;
  const { data, warnings } = encodeKeySequence(request, cursorKeyMode);
  if (!data) {
    return failText("No key data provided.");
  }
  await writeToStdin(params.stdin, data);
  return {
    content: [
      {
        type: "text",
        text:
          `Sent ${data.length} bytes to session ${params.sessionId}.` +
          (warnings.length ? `\nWarnings:\n- ${warnings.join("\n- ")}` : ""),
      },
    ],
    details: {
      status: "running",
      sessionId: params.sessionId,
      name: deriveSessionName(params.session.command),
    },
  };
}
