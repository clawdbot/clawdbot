import fs from "node:fs/promises";
import path from "node:path";

export type MemoryHostEvent = Record<string, unknown> & {
  type: string;
  timestamp: string;
};

const MEMORY_EVENT_LOG_RELATIVE_PATH = "memory/.dreams/events.jsonl";

export function resolveMemoryHostEventLogPath(workspaceDir: string): string {
  return path.join(workspaceDir, ...MEMORY_EVENT_LOG_RELATIVE_PATH.split("/"));
}

export async function appendMemoryHostEvent(
  workspaceDir: string,
  event: MemoryHostEvent,
): Promise<void> {
  const eventLogPath = resolveMemoryHostEventLogPath(workspaceDir);
  await fs.mkdir(path.dirname(eventLogPath), { recursive: true });
  await fs.appendFile(eventLogPath, `${JSON.stringify(event)}\n`, "utf8");
}
