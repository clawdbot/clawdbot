import { spawnSync } from "node:child_process";
import { Session as InspectorSession } from "node:inspector/promises";
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
  topAllocationSites: Array<{
    bytes: number;
    functionName: string;
    line: number;
    stack: string[];
    url: string;
  }>;
};

type HeapProfileNode = {
  callFrame: { functionName: string; lineNumber: number; url: string };
  children?: HeapProfileNode[];
  selfSize: number;
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

function summarizeHeapProfile(profile: {
  head: HeapProfileNode;
}): ReaderResult["topAllocationSites"] {
  const samples: Array<{ node: HeapProfileNode; stack: HeapProfileNode[] }> = [];
  const visit = (node: HeapProfileNode, stack: HeapProfileNode[]): void => {
    const nextStack = [...stack, node];
    if (node.selfSize > 0) {
      samples.push({ node, stack: nextStack });
    }
    for (const child of node.children ?? []) {
      visit(child, nextStack);
    }
  };
  const formatFrame = (
    node: HeapProfileNode,
  ): { functionName: string; line: number; url: string } => {
    const rawUrl = node.callFrame.url;
    const filePath = rawUrl.startsWith("file://") ? fileURLToPath(rawUrl) : rawUrl;
    const relativeUrl = path.isAbsolute(filePath)
      ? path.relative(process.cwd(), filePath)
      : filePath;
    return {
      functionName: node.callFrame.functionName || "(anonymous)",
      line: node.callFrame.lineNumber + 1,
      url: relativeUrl.startsWith("..") ? path.basename(filePath) : relativeUrl,
    };
  };
  visit(profile.head, []);
  return samples
    .toSorted((left, right) => right.node.selfSize - left.node.selfSize)
    .slice(0, 12)
    .map(({ node, stack }) => {
      const frame = formatFrame(node);
      return {
        bytes: node.selfSize,
        functionName: frame.functionName,
        line: frame.line,
        stack: stack
          .slice(-6)
          .map(formatFrame)
          .map(({ functionName, line, url }) => `${functionName} (${url}:${String(line)})`),
        url: frame.url,
      };
    });
}

async function runReader(): Promise<void> {
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
  const inspector = new InspectorSession();
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", { samplingInterval: 32 * 1024 });
  const manager =
    mode === "bounded"
      ? SessionManager.openBounded(target, { maxBytes: 4 * 1024 * 1024, maxEvents: 10_000 })
      : SessionManager.open(target);
  forceGc();
  const after = process.memoryUsage();
  const { profile } = (await inspector.post("HeapProfiler.stopSampling")) as {
    profile: { head: HeapProfileNode };
  };
  inspector.disconnect();
  const result: ReaderResult = {
    mode,
    entries: manager.getEntries().length,
    heapUsedDeltaBytes: after.heapUsed - before.heapUsed,
    rssDeltaBytes: after.rss - before.rss,
    peakRssBytes: Math.round(process.resourceUsage().maxRSS * 1024),
    topAllocationSites: summarizeHeapProfile(profile),
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
  if (result.error) {
    throw new Error(`${params.mode} reader failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${params.mode} reader failed: ${result.stderr || result.stdout}`);
  }
  const line = result.stdout
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith(readerSentinel));
  if (!line) {
    throw new Error(
      `${params.mode} reader omitted its result: ${result.stderr || result.stdout || "no output"}`,
    );
  }
  return JSON.parse(line.slice(readerSentinel.length)) as ReaderResult;
}

async function main(): Promise<void> {
  if (process.argv.includes("--reader")) {
    await runReader();
    return;
  }
  const eventCount = Number.parseInt(process.env.OPENCLAW_BENCH_EVENTS ?? "2048", 10);
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
      { agentId: "main", sessionKey, storePath },
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
