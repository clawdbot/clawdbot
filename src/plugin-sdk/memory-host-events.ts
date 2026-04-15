import fs from "node:fs/promises";
import { appendMemoryHostEvent, resolveMemoryHostEventLogPath, type MemoryHostEvent } from "./memory-core-host-events.js";

export { appendMemoryHostEvent, resolveMemoryHostEventLogPath, type MemoryHostEvent };

export async function readMemoryHostEvents(params: {
  workspaceDir: string;
}): Promise<MemoryHostEvent[]> {
  const eventLogPath = resolveMemoryHostEventLogPath(params.workspaceDir);
  const raw = await fs.readFile(eventLogPath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return [];
      }
      try {
        const parsed = JSON.parse(trimmed) as MemoryHostEvent;
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof parsed.type === "string" &&
          typeof parsed.timestamp === "string"
        ) {
          return [parsed];
        }
      } catch {}
      return [];
    });
}
