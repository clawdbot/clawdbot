import fs from "node:fs/promises";

const POLL_INTERVAL_MS = 200;
const RUN_EVENT_SETTLE_MS = 2_000;
const WAIT_TIMEOUT_MS = 30_000;

export type ProbeRunEvent = {
  phase: "listening" | "started";
  pid: number;
  ppid: number;
};

async function readRunEvents(eventsPath: string): Promise<ProbeRunEvent[]> {
  const content = await fs.readFile(eventsPath, "utf8").catch(() => "");
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line) as Partial<ProbeRunEvent>;
      if (
        (parsed.phase !== "started" && parsed.phase !== "listening") ||
        !Number.isSafeInteger(parsed.pid) ||
        (parsed.pid ?? 0) <= 1 ||
        !Number.isSafeInteger(parsed.ppid) ||
        (parsed.ppid ?? 0) <= 1
      ) {
        throw new Error("Scheduled Task probe recorded an invalid run event");
      }
      return parsed as ProbeRunEvent;
    });
}

export async function waitForExactProbeRun(
  eventsPath: string,
  expectedCount: number,
): Promise<ProbeRunEvent> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let events: ProbeRunEvent[] = [];
  while (Date.now() < deadline) {
    events = await readRunEvents(eventsPath);
    if (events.filter((event) => event.phase === "listening").length >= expectedCount) {
      await new Promise((resolve) => {
        setTimeout(resolve, RUN_EVENT_SETTLE_MS);
      });
      events = await readRunEvents(eventsPath);
      break;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_INTERVAL_MS);
    });
  }

  const started = events.filter((event) => event.phase === "started");
  const listening = events.filter((event) => event.phase === "listening");
  if (started.length !== expectedCount || listening.length !== expectedCount) {
    throw new Error(
      `Expected exactly ${expectedCount} Scheduled Task probe runs; observed ${started.length} starts and ${listening.length} listeners`,
    );
  }
  const startedEvent = started[expectedCount - 1];
  const listeningEvent = listening[expectedCount - 1];
  if (!startedEvent || !listeningEvent) {
    throw new Error(`Scheduled Task run ${expectedCount} did not record complete process events`);
  }
  if (startedEvent.pid !== listeningEvent.pid || startedEvent.ppid !== listeningEvent.ppid) {
    throw new Error(
      `Scheduled Task run ${expectedCount} changed process identity before listening`,
    );
  }
  return startedEvent;
}
