import { randomUUID } from "node:crypto";
import {
  summarizeLiveTransportRttSamples,
  type LiveTransportRttSample,
} from "./live-transports/shared/live-transport-rtt.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import type { QaBusInboundMessageInput } from "./runtime-api.js";

export type QaSuiteRoundTripProbe = {
  scenarioId: string;
  count: number;
  maxFailures: number;
  timeoutMs: number;
  markerPrefix: string;
  input: Omit<QaBusInboundMessageInput, "replyToId" | "text">;
  textPrefix: string;
  chainReplies?: boolean;
};

export async function runQaSuiteRoundTripProbe(params: {
  probe: QaSuiteRoundTripProbe;
  transport: QaTransportAdapter;
}) {
  const samples: LiveTransportRttSample[] = [];
  let failures = 0;
  let passed = 0;
  let latestReplyId = params.transport.state
    .getSnapshot()
    .messages.findLast((message) => message.direction === "outbound")?.id;

  for (let index = 1; passed < params.probe.count; index += 1) {
    const marker = `${params.probe.markerPrefix}-${index}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const outboundStartIndex = params.transport.state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound").length;
    const startedAt = Date.now();
    try {
      await params.transport.sendInbound({
        ...params.probe.input,
        text: `${params.probe.textPrefix}${marker}`,
        ...(params.probe.chainReplies && latestReplyId ? { replyToId: latestReplyId } : {}),
      });
      const reply = await params.transport.waitForOutbound({
        conversation: params.probe.input.conversation,
        sinceIndex: outboundStartIndex,
        textIncludes: marker,
        timeoutMs: params.probe.timeoutMs,
      });
      latestReplyId = reply.id;
      samples.push({ status: "pass", rttMs: Math.max(1, Date.now() - startedAt) });
      passed += 1;
    } catch {
      samples.push({ status: "fail" });
      failures += 1;
    }
    if (failures >= params.probe.maxFailures) {
      break;
    }
  }

  const summary = summarizeLiveTransportRttSamples(samples);
  return {
    ...summary,
    details: `${summary.passed}/${samples.length} RTT checks passed`,
  };
}
