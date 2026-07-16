// Client-side trigger script loading for cron create/edit commands.
import { createReadStream } from "node:fs";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";

const MAX_CRON_TRIGGER_SCRIPT_BYTES = 65_536;

async function readTriggerScriptStream(stream: AsyncIterable<unknown>): Promise<string> {
  const bytes = await readByteStreamWithLimit(stream, {
    maxBytes: MAX_CRON_TRIGGER_SCRIPT_BYTES,
    onOverflow: () => new Error(`Trigger script exceeds ${MAX_CRON_TRIGGER_SCRIPT_BYTES} bytes`),
  });
  return bytes.toString("utf8");
}

/** Reads a trigger script locally before sending the cron RPC. */
export async function readCronTriggerScript(
  source: string,
  deps?: {
    stdin?: AsyncIterable<unknown>;
  },
): Promise<string> {
  const stream = source === "-" ? (deps?.stdin ?? process.stdin) : createReadStream(source);
  const raw = await readTriggerScriptStream(stream);
  const script = raw.trim();
  if (!script) {
    throw new Error("Trigger script must not be empty");
  }
  return script;
}
