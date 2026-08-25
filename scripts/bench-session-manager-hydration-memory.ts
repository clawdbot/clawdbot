import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "../src/agents/sessions/session-manager.js";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../src/config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

const scriptPath = fileURLToPath(import.meta.url);
const readerSentinel = "OPENCLAW_SESSION_HYDRATION_MEMORY:";

type ReaderResult = {
  mode: "bounded" | "full";
  entries: number;
  heapUsedDeltaBytes: number;
  rssDeltaBytes: number;
  peakRssBytes: number;
};

function forceGc(): void {
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (!gc) {
    throw new Error("reader requires --expose-gc");
  }
  gc();
  gc();
}

function readArg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function runReader(): void {
  const mode = readArg("--mode") as ReaderResult["mode"];
  if (mode !== "full" && mode !== "bounded") {
    throw new Error("--mode must be full or bounded");
  }
  const target = {
    agentId: "main",
    sessionId: readArg("--session-id"),
    sessionKey: readArg("--session-key"),
    storePath: readArg("--store-path"),
  };
  forceGc();
  const before = process.memoryUsage();
  const manager =
    mode === "bounded"
      ? SessionManager.openBounded(target, { maxBytes: 4 * 1024 * 1024, maxEvents: 10_000 })
      : SessionManager.open(target);
  forceGc();
  const after = process.memoryUsage();
  const result: ReaderResult = {
    mode,
    entries: manager.getEntries().length,
    heapUsedDeltaBytes: after.heapUsed - before.heapUsed,
    rssDeltaBytes: after.rss - before.rss,
    peakRssBytes: Math.round(process.resourceUsage().maxRSS * 1024),
  };
  process.stdout.write(`${readerSentinel}${JSON.stringify(result)}\n`);
}

function runChild(params: {
  mode: ReaderResult["mode"];
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): ReaderResult {
  const result = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      "--import",
      "tsx",
      scriptPath,
      "--reader",
      "--mode",
      params.mode,
      "--session-id",
      params.sessionId,
      "--session-key",
      params.sessionKey,
      "--store-path",
      params.storePath,
    ],
    { encoding: "utf8", env: process.env },
  );
  if (result.status !== 0) {
    throw new Error(`${params.mode} reader failed: ${result.stderr || result.stdout}`);
  }
  const line = result.stdout
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith(readerSentinel));
  if (!line) {
    throw new Error(`${params.mode} reader omitted its result`);
  }
  return JSON.parse(line.slice(readerSentinel.length)) as ReaderResult;
}

async function main(): Promise<void> {
  if (process.argv.includes("--reader")) {
    runReader();
    return;
  }
  const eventCount = Number.parseInt(process.env.OPENCLAW_BENCH_EVENTS ?? "2000", 10);
  const eventBytes = Number.parseInt(process.env.OPENCLAW_BENCH_EVENT_BYTES ?? "65536", 10);
  if (!Number.isInteger(eventCount) || eventCount < 1 || eventCount > 10_000) {
    throw new Error("OPENCLAW_BENCH_EVENTS must be between 1 and 10000");
  }
  if (!Number.isInteger(eventBytes) || eventBytes < 1024 || eventBytes > 1024 * 1024) {
    throw new Error("OPENCLAW_BENCH_EVENT_BYTES must be between 1024 and 1048576");
  }

  await withOpenClawTestState({ label: "session-hydration-memory" }, async (state) => {
    const sessionId = "hydration-memory";
    const sessionKey = "agent:main:hydration-memory";
    const storePath = path.join(state.sessionsDir("main"), "sessions.json");
    await upsertSessionEntryCore(
      { agentId: "main", sessionId, sessionKey, storePath },
      { sessionId, updatedAt: 1 },
    );
    const content = "x".repeat(eventBytes);
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        messages: Array.from({ length: eventCount }, (_, index) => ({
          eventId: `message-${index}`,
          parentId: index === 0 ? null : `message-${index - 1}`,
          message: { role: index % 2 === 0 ? "user" : "assistant", content },
        })),
        touchSessionEntry: false,
      },
    );

    const full = runChild({ mode: "full", sessionId, sessionKey, storePath });
    const bounded = runChild({ mode: "bounded", sessionId, sessionKey, storePath });
    const output = {
      eventCount,
      eventBytes,
      serializedPayloadBytes: eventCount * eventBytes,
      full,
      bounded,
      heapReductionBytes: full.heapUsedDeltaBytes - bounded.heapUsedDeltaBytes,
      rssReductionBytes: full.rssDeltaBytes - bounded.rssDeltaBytes,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  });
}

await main();
