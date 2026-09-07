import type { TraceEvent, TraceNormalizer } from "openclaw/plugin-sdk/channel-contract-testing";

export const EXEC_FAILED_PROSE = "The directory is missing.";

/** Canonicalizes Slack `sec.micro` timestamps to `ts#N` in first-seen order. */
export function createSlackTsNormalizer(): TraceNormalizer {
  const seen = new Map<string, string>();
  const canonicalize = (value: string) =>
    value.replace(/\b\d{10}\.\d{6}\b/g, (ts) => {
      let mapped = seen.get(ts);
      if (!mapped) {
        mapped = `ts#${seen.size + 1}`;
        seen.set(ts, mapped);
      }
      return mapped;
    });
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      return canonicalize(value);
    }
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, walk(entry)]),
      );
    }
    return value;
  };
  return (event: TraceEvent) =>
    event.data === undefined ? event : { ...event, data: walk(event.data) };
}

export function collectSlackWireTexts(events: readonly TraceEvent[]): string[] {
  const texts: string[] = [];
  const pushText = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) {
      texts.push(value);
    }
  };
  for (const event of events) {
    if (event.dir !== "out" || !event.data || typeof event.data !== "object") {
      continue;
    }
    const payload = (event.data as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object") {
      continue;
    }
    const record = payload as Record<string, unknown>;
    pushText(record.text);
    pushText(record.markdown_text);
    if (Array.isArray(record.chunks)) {
      for (const chunk of record.chunks) {
        if (chunk && typeof chunk === "object") {
          pushText((chunk as { text?: unknown }).text);
        }
      }
    }
  }
  return texts;
}

export function buildSlackDeliveryProofVerdict(params: {
  scenario: string;
  events: readonly TraceEvent[];
  headSha: string;
}): Record<string, unknown> {
  const wireTexts = collectSlackWireTexts(params.events);
  return {
    kind: "mock-gateway",
    liveSlack: false,
    harness: "extensions/slack/src/delivery-trace.test.ts",
    channel: "slack",
    scenario: params.scenario,
    headSha: params.headSha,
    environment: {
      node: process.version,
      platform: process.platform,
      slackApi: "recording WebClient",
      provider: "scripted agent turn",
      delivery: "real dispatchPreparedSlackMessage + ChatStreamer/draft preview",
    },
    inboundPayloads: params.events
      .filter((event) => event.dir === "in" && (event.kind === "final" || event.kind === "partial"))
      .map((event) => event.data),
    deliveredWireTexts: wireTexts,
    execFailedDelivered: wireTexts.some((text) => text.includes("Exec failed")),
    proseDelivered: wireTexts.some((text) => text.includes(EXEC_FAILED_PROSE)),
    outMethods: params.events.filter((event) => event.dir === "out").map((event) => event.kind),
  };
}
