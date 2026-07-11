/**
 * Delivery trace harness for channel conformance goldens.
 *
 * Records a channel's delivery lifecycle as a replayable JSONL trace:
 * - IN events are the script fed to the channel's dispatcher wiring (what
 *   `createReplyDispatcherWithTyping` consumers receive today: replyStart,
 *   cumulative partial text, block boundary, tool progress, final payload,
 *   cancel, idle).
 * - OUT events are the ordered wire-effect calls observed at the channel's
 *   mocked SDK/HTTP client: method, normalized target, normalized payload,
 *   scripted result. Typing calls included.
 *
 * Goldens are committed fixtures in each channel plugin's own
 * `src/__traces__/<scenario>.trace.jsonl` (the adopting test passes its golden
 * URL in; this core module never references plugin paths, which the channel
 * import guardrails enforce). They act as the conformance oracle for the
 * Phase-4 delivery engines: the
 * engines must reproduce the recorded out-sequences from the identical scripts.
 * Goldens capture behavior (wire calls, order, payloads), never internals.
 *
 * Adding a channel:
 * 1. In the extension's own test file, build the channel's real dispatcher or
 *    deliver wiring against a mocked wire client that reports every call via
 *    `recorder.recordWireCall(...)` with scripted deterministic results.
 * 2. Map each `DeliveryTraceInStep` onto that wiring in the `setup` callback
 *    passed to `runDeliveryTraceScenario` (unsupported steps map to no-ops).
 * 3. Assert with `expectDeliveryTraceMatchesGolden`. Record or refresh goldens
 *    with `OPENCLAW_TRACE_UPDATE=1 pnpm test <test-file>`; CI runs in verify
 *    mode and fails on any ordering/payload drift.
 *
 * Determinism contract: the runner installs fake timers at a fixed epoch and
 * drives time only through explicit `advance` steps, so throttle/debounce
 * sequences replay identically; recorded `at` values are relative offsets. Mocked clients must return scripted deterministic ids;
 * any remaining volatile field is canonicalized by the channel's
 * `TraceNormalizer`. Serialization sorts nested object keys so goldens are
 * byte-stable across runs and platforms.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";

export type TraceEventDir = "in" | "out";

/** One recorded trace event. `at` is fake-clock milliseconds since scenario start. */
export type TraceEvent = {
  seq: number;
  at: number;
  dir: TraceEventDir;
  kind: string;
  data?: unknown;
};

/** Canonicalizes volatile fields (ids, timestamps) before compare/write. */
export type TraceNormalizer = (event: TraceEvent) => TraceEvent;

/** Agent-side lifecycle steps a channel maps onto its dispatcher wiring. */
export type DeliveryTraceInStep =
  | { kind: "reply-start" }
  | { kind: "partial"; text: string }
  | { kind: "block-final"; text: string }
  | { kind: "tool-progress"; name: string; phase: "start" | "result" }
  | { kind: "final"; text?: string; mediaUrls?: string[]; isError?: boolean }
  | { kind: "cancel" }
  | { kind: "idle" }
  | { kind: "wire-fault"; fault: "rate-limit"; retryAfterMs: number };

export type DeliveryTraceStep = DeliveryTraceInStep | { kind: "advance"; ms: number };

export type DeliveryTraceScenario = {
  name: DeliveryTraceScenarioName;
  steps: readonly DeliveryTraceStep[];
};

export type DeliveryTraceScenarioName =
  | "streaming-happy"
  | "final-only"
  | "cancel-mid-stream"
  | "rate-limit-during-preview"
  | "media-with-caption"
  | "overflow-pagination";

export type WireRecorder = {
  /** Channel mocks report each wire effect here, in observed order. */
  recordWireCall: (call: {
    method: string;
    target?: string;
    payload?: unknown;
    result?: unknown;
  }) => void;
  /** Runner-internal: records a script step as an IN event. */
  recordInEvent: (kind: string, data?: unknown) => void;
  finish: () => TraceEvent[];
};

export function createWireRecorder(): WireRecorder {
  const events: TraceEvent[] = [];
  // `at` is relative to recorder creation so goldens stay small and stable
  // while the fake clock itself runs at a realistic epoch.
  const baseAtMs = Date.now();
  const record = (dir: TraceEventDir, kind: string, data?: unknown) => {
    events.push({
      seq: events.length + 1,
      at: Date.now() - baseAtMs,
      dir,
      kind,
      ...(data === undefined ? {} : { data }),
    });
  };
  return {
    recordWireCall: ({ method, ...data }) => {
      record("out", method, data);
    },
    recordInEvent: (kind, data) => {
      record("in", kind, data);
    },
    finish: () => events.slice(),
  };
}

function overflowFinalText(): string {
  // Deterministic body large enough to exceed every adopting channel's chunk
  // limit (feishu/mattermost default 4000) so pagination is exercised.
  const lines: string[] = [];
  for (let index = 1; index <= 180; index += 1) {
    lines.push(
      `${String(index).padStart(4, "0")} overflow pagination line with deterministic filler text.`,
    );
  }
  return lines.join("\n");
}

const STREAMING_BLOCK_ONE = "Deploy status: build is green.";
const STREAMING_BLOCK_TWO = "Rolling out to production now.";

/**
 * Shared scenario shapes (spec v1 library). Channels adopt the subset that
 * applies and record channel-specific goldens for each adopted scenario.
 */
export const deliveryTraceScenarios: Record<DeliveryTraceScenarioName, DeliveryTraceScenario> = {
  "streaming-happy": {
    name: "streaming-happy",
    steps: [
      { kind: "reply-start" },
      { kind: "partial", text: "Deploy status:" },
      { kind: "advance", ms: 300 },
      { kind: "partial", text: STREAMING_BLOCK_ONE },
      { kind: "advance", ms: 300 },
      { kind: "block-final", text: STREAMING_BLOCK_ONE },
      { kind: "partial", text: STREAMING_BLOCK_TWO },
      { kind: "advance", ms: 300 },
      { kind: "final", text: `${STREAMING_BLOCK_ONE}\n\n${STREAMING_BLOCK_TWO}` },
      { kind: "idle" },
    ],
  },
  "final-only": {
    name: "final-only",
    steps: [
      { kind: "reply-start" },
      { kind: "final", text: "All checks passed." },
      { kind: "idle" },
    ],
  },
  "cancel-mid-stream": {
    name: "cancel-mid-stream",
    steps: [
      { kind: "reply-start" },
      { kind: "partial", text: "Working on the fix" },
      { kind: "advance", ms: 300 },
      { kind: "partial", text: "Working on the fix: patching now." },
      { kind: "advance", ms: 300 },
      { kind: "cancel" },
      { kind: "idle" },
    ],
  },
  "rate-limit-during-preview": {
    name: "rate-limit-during-preview",
    steps: [
      { kind: "reply-start" },
      { kind: "partial", text: "Collecting logs" },
      { kind: "advance", ms: 300 },
      { kind: "wire-fault", fault: "rate-limit", retryAfterMs: 1000 },
      { kind: "partial", text: "Collecting logs from the gateway." },
      // Past the scripted retryAfterMs window, so the recorded recovery never
      // blesses wire traffic inside the rate-limit backoff interval.
      { kind: "advance", ms: 1100 },
      { kind: "partial", text: "Collecting logs from the gateway. Found the failure." },
      { kind: "advance", ms: 300 },
      { kind: "final", text: "Collecting logs from the gateway. Found the failure." },
      { kind: "idle" },
    ],
  },
  "media-with-caption": {
    name: "media-with-caption",
    steps: [
      { kind: "reply-start" },
      {
        kind: "final",
        text: "Here is the requested chart.",
        mediaUrls: ["https://example.com/chart.png"],
      },
      { kind: "idle" },
    ],
  },
  "overflow-pagination": {
    name: "overflow-pagination",
    steps: [
      { kind: "reply-start" },
      { kind: "partial", text: "Generating the full report." },
      { kind: "advance", ms: 300 },
      { kind: "final", text: overflowFinalText() },
      { kind: "idle" },
    ],
  },
};

export type DeliveryTraceDispatch = (step: DeliveryTraceInStep) => void | Promise<void>;

// A realistic fixed epoch instead of 0: throttle loops seeded with lastSent=0
// would treat scenario start as "just sent", and clock-validity guards
// (e.g. feishu token expiry) reject implausible timestamps.
const DELIVERY_TRACE_EPOCH_MS = Date.UTC(2026, 0, 1);

/**
 * Runs one scenario under fake timers and returns the recorded trace.
 *
 * `setup` builds the channel wiring (mocked wire client writing into the
 * recorder) and returns the per-step dispatcher. It runs under the scenario's
 * fake clock so construction-time timestamps stay deterministic.
 */
export async function runDeliveryTraceScenario(params: {
  scenario: DeliveryTraceScenario;
  setup: (recorder: WireRecorder) => DeliveryTraceDispatch | Promise<DeliveryTraceDispatch>;
  normalize?: TraceNormalizer;
}): Promise<TraceEvent[]> {
  vi.useFakeTimers({ now: DELIVERY_TRACE_EPOCH_MS });
  try {
    const recorder = createWireRecorder();
    const dispatch = await params.setup(recorder);
    for (const step of params.scenario.steps) {
      if (step.kind === "advance") {
        await vi.advanceTimersByTimeAsync(step.ms);
        continue;
      }
      const { kind, ...data } = step;
      recorder.recordInEvent(kind, Object.keys(data).length > 0 ? data : undefined);
      await dispatch(step);
      // Drain microtasks and 0ms timers so queued wire effects land before the
      // next scripted step; explicit `advance` steps own all longer waits.
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(0);
    const events = recorder.finish();
    return params.normalize ? events.map(params.normalize) : events;
  } finally {
    vi.useRealTimers();
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(",")}}`;
}

/** JSONL with fixed top-level key order and sorted nested keys (byte-stable). */
export function serializeDeliveryTrace(events: readonly TraceEvent[]): string {
  const lines = events.map((event) => {
    const data = event.data === undefined ? "" : `,"data":${canonicalJson(event.data)}`;
    return `{"seq":${event.seq},"at":${event.at},"dir":${JSON.stringify(event.dir)},"kind":${JSON.stringify(event.kind)}${data}}`;
  });
  return `${lines.join("\n")}\n`;
}

const TRACE_UPDATE_ENV = "OPENCLAW_TRACE_UPDATE";

/**
 * Verify mode (default, CI): asserts the full ordered event sequence equals the
 * committed golden. Update mode (`OPENCLAW_TRACE_UPDATE=1`): rewrites the golden.
 */
export function expectDeliveryTraceMatchesGolden(params: {
  goldenUrl: URL;
  events: readonly TraceEvent[];
}): void {
  const goldenPath = fileURLToPath(params.goldenUrl);
  const actual = serializeDeliveryTrace(params.events);
  if (process.env[TRACE_UPDATE_ENV] === "1") {
    mkdirSync(path.dirname(goldenPath), { recursive: true });
    writeFileSync(goldenPath, actual, "utf8");
    return;
  }
  let golden: string;
  try {
    golden = readFileSync(goldenPath, "utf8");
  } catch {
    throw new Error(
      `Missing delivery trace golden ${goldenPath}. Record it with ${TRACE_UPDATE_ENV}=1.`,
    );
  }
  // Tolerate CRLF checkouts; goldens are authored with LF line endings.
  const normalizeEol = (text: string) => text.replace(/\r\n/g, "\n");
  expect(
    normalizeEol(actual),
    `delivery trace drifted from ${path.basename(goldenPath)}; if the new wire behavior is intended, refresh with ${TRACE_UPDATE_ENV}=1`,
  ).toBe(normalizeEol(golden));
}
