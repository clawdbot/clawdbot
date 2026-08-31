import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState, type QaBusState } from "./bus-state.js";
import { createQaGatewayChild } from "./gateway-child.js";
import {
  QA_TWO_WAVE_OBSERVED_FINAL_MARKER,
  type MockOpenAiRequestSnapshot,
} from "./providers/mock-openai/mock-openai-contracts.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import type { QaBusMessage } from "./runtime-api.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const TRIGGER = "two-wave requester settle qa check";
const REQUESTER_CONVERSATION = { id: "requester-user", kind: "direct" as const };
const DIRECT_DELIVERY_CAPTURE_PATH =
  "/tmp/oc-129635-continuation-proof/direct-announcement-delivery.debug.json";
const POLICY_ORIGIN_CAPTURE_PATH =
  "/tmp/oc-129635-continuation-proof/source-reply-policy-origin.debug.json";

/**
 * Test-controlled seam: merge QA transport counts into the delivery capture artifact.
 * No raw content, no PII — only integer counts.
 */
function mergeTransportCountsIntoCapture(state: QaBusState, outboundStartIndex: number): void {
  try {
    const allOutbound = state
      .getSnapshot()
      .messages.filter((m: { direction: string }) => m.direction === "outbound");
    const outboundSinceTrigger = allOutbound.slice(outboundStartIndex);
    const markerBearingCount = outboundSinceTrigger.filter((m: { text?: string }) =>
      m.text?.includes(QA_TWO_WAVE_OBSERVED_FINAL_MARKER),
    ).length;
    const transportCounts = {
      qaTransportOutboundTotalSinceTrigger: outboundSinceTrigger.length,
      qaTransportMarkerBearingOutboundCount: markerBearingCount,
    };
    if (existsSync(DIRECT_DELIVERY_CAPTURE_PATH)) {
      const existing = JSON.parse(readFileSync(DIRECT_DELIVERY_CAPTURE_PATH, "utf8")) as Record<
        string,
        unknown
      >;
      writeFileSync(
        DIRECT_DELIVERY_CAPTURE_PATH,
        JSON.stringify({ ...existing, ...transportCounts }, null, 2),
        "utf8",
      );
    } else {
      writeFileSync(DIRECT_DELIVERY_CAPTURE_PATH, JSON.stringify(transportCounts, null, 2), "utf8");
    }
  } catch {
    // Transport count merge must never block the test.
  }
}

function writeSanitizedVerdict(verdict: Record<string, unknown>): void {
  writeFileSync("/tmp/oc-129635-continuation-proof/verdict.json", JSON.stringify(verdict, null, 2));
}

/**
 * Reads the sanitized policy-origin capture (fixed enums/booleans only) and
 * summarizes the last event at each capture point, for correlation with the
 * direct-delivery capture. Never touches prompt/message/session data.
 */
function readPolicyOriginSummary(): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(POLICY_ORIGIN_CAPTURE_PATH, "utf8")) as {
      events?: Array<Record<string, unknown>>;
    };
    const events = raw.events ?? [];
    const lastByPoint = (point: string) =>
      events.toReversed().find((e) => e.point === point) ?? null;
    return {
      resolvedModes: lastByPoint("get-reply-run-context.resolved-modes"),
      sourcePolicyResolved: lastByPoint("followup-delivery.source-policy-resolved"),
      finalDecision: lastByPoint("followup-delivery.decision"),
      eventCount: events.length,
    };
  } catch {
    return { resolvedModes: null, sourcePolicyResolved: null, finalDecision: null, eventCount: 0 };
  }
}

const SETTLE_WAKE_NEEDLE =
  "[Subagent Context] Every subagent spawned from this session has now settled";

function isRequesterRequest(r: MockOpenAiRequestSnapshot) {
  return r.allInputText.includes(TRIGGER);
}

async function pollDebugRequests(
  baseUrl: string,
  predicate: (reqs: MockOpenAiRequestSnapshot[]) => MockOpenAiRequestSnapshot | undefined,
  timeoutMs: number,
): Promise<MockOpenAiRequestSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/debug/requests?after=0`);
    const all = (await res.json()) as MockOpenAiRequestSnapshot[];
    const match = predicate(all);
    if (match) {
      return match;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  throw new Error(`pollDebugRequests timed out after ${timeoutMs}ms`);
}

describe("two-wave requester-settle observed proof", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  });

  it("proves barrier-observed two-wave requester-settle with quiet gate", async () => {
    writeFileSync(
      DIRECT_DELIVERY_CAPTURE_PATH,
      JSON.stringify({
        schemaVersion: 2,
        gatewayBuild: "qa-repo-cli",
        attempts: [],
      }),
      "utf8",
    );
    writeFileSync(
      POLICY_ORIGIN_CAPTURE_PATH,
      JSON.stringify({ schemaVersion: 1, events: [] }, null, 2),
      "utf8",
    );
    // Seed a privacy-safe artifact before gateway/process work starts, so an
    // outer runner timeout still leaves a conclusive bounded diagnostic.
    writeSanitizedVerdict({
      schemaVersion: 1,
      phase: "started",
      wave1SpawnObserved: false,
      wave1YieldObserved: false,
      wave1SettleWakeObserved: false,
      quietDuringBarrier: false,
      wave2SpawnObserved: false,
      wave2SettleWakeObserved: false,
      finalObserved: false,
      exactlyOneFinalOutbound: false,
      postFinalQuiet: false,
      qaTransportOutboundTotalSinceTrigger: 0,
      qaTransportMarkerBearingOutboundCount: 0,
    });
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    const bus = await startQaBusServer({ state });
    cleanups.push(() => bus.stop());

    // barrier: held on first settle wake until released
    let settleWakesSeen = 0;
    let releaseWave1Barrier: (() => void) | undefined;
    const wave1Barrier = new Promise<void>((resolve) => {
      releaseWave1Barrier = resolve;
    });

    const mock = await startQaMockOpenAiServer({
      onBeforeRespond: async (snapshot) => {
        if (isRequesterRequest(snapshot) && snapshot.allInputText.includes(SETTLE_WAKE_NEEDLE)) {
          settleWakesSeen++;
          if (settleWakesSeen === 1) {
            await wave1Barrier;
          }
        }
      },
    });
    cleanups.push(() => mock.stop());

    const gatewayOwner = createQaGatewayChild();
    const gateway = await gatewayOwner.start({
      repoRoot: REPO_ROOT,
      useRepoCli: true,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      transport,
      transportBaseUrl: bus.baseUrl,
      controlUiEnabled: false,
      runtimeEnvPatch: {
        OPENCLAW_SUBAGENT_DIRECT_DELIVERY_CAPTURE_PATH:
          "/tmp/oc-129635-continuation-proof/direct-announcement-delivery.debug.json",
        OPENCLAW_SOURCE_REPLY_POLICY_CAPTURE_PATH: POLICY_ORIGIN_CAPTURE_PATH,
      },
    });
    cleanups.push(() => gatewayOwner.stop().then(() => undefined));
    await transport.waitReady({ gateway });

    const outboundStartIndex = state
      .getSnapshot()
      .messages.filter((m: QaBusMessage) => m.direction === "outbound").length;

    await transport.sendInbound({
      accountId: "default",
      conversation: REQUESTER_CONVERSATION,
      senderId: REQUESTER_CONVERSATION.id,
      text: TRIGGER,
    });

    /**
     * Build a failure error with only safe aggregate counts and booleans.
     * No raw message text, prompts, session IDs, destination details, or
     * gateway log lines may appear in the thrown error or its cause.
     *
     * errorKind maps the thrown value to a finite safe enum — never
     * interpolates message text, String(error), or raw cause.
     */
    type FailureKind = "assertion" | "unknown";
    const classifyFailure = (e: unknown): FailureKind =>
      e instanceof Error && e.constructor?.name === "AssertionError" ? "assertion" : "unknown";

    const failureContext = (error: unknown, label: string): Error => {
      const snap = state.getSnapshot();
      const allOutbound = snap.messages.filter(
        (m: { direction: string }) => m.direction === "outbound",
      );
      const outboundSinceTrigger = allOutbound.slice(outboundStartIndex);
      return new Error(
        [
          label,
          `errorKind=${classifyFailure(error)}`,
          `outboundTotalSinceTrigger=${outboundSinceTrigger.length}`,
          `outboundMarkerBearingCount=${outboundSinceTrigger.filter((m: { text?: string }) => m.text?.includes(QA_TWO_WAVE_OBSERVED_FINAL_MARKER)).length}`,
          `settleWakesSeen=${settleWakesSeen}`,
        ].join("\n"),
      );
    };

    let wave1SpawnObserved = false;
    let wave1YieldObserved = false;
    let wave1SettleWakeObserved = false;
    let quietDuringBarrier = false;
    let wave2SpawnObserved = false;
    let wave2SettleWakeObserved = false;
    let finalObserved = false;
    let postFinalQuiet = false;

    try {
      // Step 1: observe Wave 1 sessions_spawn
      const wave1SpawnReq = await pollDebugRequests(
        mock.baseUrl,
        (reqs) =>
          reqs.filter(isRequesterRequest).find((r) => r.plannedToolName === "sessions_spawn"),
        30_000,
      );
      wave1SpawnObserved = true;
      expect(wave1SpawnReq.plannedToolArgs?.task).toMatch(/two-wave qa worker wave-1/i);

      // Step 2: observe Wave 1 sessions_yield
      const wave1YieldReq = await pollDebugRequests(
        mock.baseUrl,
        (reqs) =>
          reqs.filter(isRequesterRequest).find((r) => r.plannedToolName === "sessions_yield"),
        30_000,
      );
      wave1YieldObserved = true;
      expect(wave1YieldReq.cursor).toBeGreaterThan(wave1SpawnReq.cursor);

      // Step 3: observe Wave 1 settle wake request (barrier holds it)
      const wave1SettleWakeReq = await pollDebugRequests(
        mock.baseUrl,
        (reqs) =>
          reqs.filter(isRequesterRequest).find((r) => r.allInputText.includes(SETTLE_WAKE_NEEDLE)),
        30_000,
      );
      wave1SettleWakeObserved = true;
      expect(wave1SettleWakeReq.cursor).toBeGreaterThan(wave1YieldReq.cursor);
      // The fix allows continuation: the settle wake response must plan sessions_spawn.
      // On the baseline the mock returns a premature final (plannedToolName undefined),
      // failing this gate while the barrier is still active — no outbound yet.
      expect(wave1SettleWakeReq.plannedToolName).toBe("sessions_spawn");

      // Anchor quiet window on the current outbound count
      const outboundAtBarrier = state
        .getSnapshot()
        .messages.filter((m: QaBusMessage) => m.direction === "outbound").length;

      // Step 4: quiet gate — no final outbound while barrier holds
      await transport.waitForNoOutbound({
        sinceIndex: outboundAtBarrier,
        quietMs: 8_000,
      });
      quietDuringBarrier = true;

      // Step 5: release barrier
      releaseWave1Barrier!();

      // Step 6: observe Wave 2 sessions_spawn
      const wave2SpawnReq = await pollDebugRequests(
        mock.baseUrl,
        (reqs) => {
          const requesterSpawns = reqs
            .filter(isRequesterRequest)
            .filter((r) => r.plannedToolName === "sessions_spawn");
          return requesterSpawns[1]; // second spawn is Wave 2
        },
        30_000,
      );
      wave2SpawnObserved = true;
      expect(wave2SpawnReq.plannedToolArgs?.task).toMatch(/two-wave qa worker wave-2/i);

      // Wave 2 is terminal in this real path. Unlike Wave 1, it does not issue
      // a second sessions_yield after its spawn result. Its successor completion
      // resumes the requester directly for final delivery.

      // Step 7: observe the successor's real completion resume. Unlike Wave 1,
      // this provider-visible inter-session turn omits the child-result block,
      // so identify it by its source session and ordering after Wave 2 spawn.
      const wave2SettleWakeReq = await pollDebugRequests(
        mock.baseUrl,
        (reqs) =>
          reqs
            .filter((r) => r.prompt.includes("[Inter-session message]"))
            .find((r) => r.cursor > wave2SpawnReq.cursor && !r.prompt.includes("WAVE-1-RESULT")),
        30_000,
      );
      wave2SettleWakeObserved = true;
      expect(wave2SettleWakeReq.cursor).toBeGreaterThan(wave2SpawnReq.cursor);

      // Step 9: observe exactly one final outbound message
      const finalOutbound = await transport.waitForOutbound({
        conversation: REQUESTER_CONVERSATION,
        sinceIndex: outboundStartIndex,
        textIncludes: QA_TWO_WAVE_OBSERVED_FINAL_MARKER,
        timeoutMs: 30_000,
      });
      finalObserved = true;

      const outboundAfterFinal =
        state
          .getSnapshot()
          .messages.filter((m: QaBusMessage) => m.direction === "outbound")
          .findIndex((m: QaBusMessage) => m.id === finalOutbound.id) + 1;

      // Verify exactly one final outbound (no earlier premature final)
      const allOutboundSinceTrigger = state
        .getSnapshot()
        .messages.filter((m: QaBusMessage) => m.direction === "outbound")
        .slice(outboundStartIndex);
      const finalsWithMarker = allOutboundSinceTrigger.filter((m: QaBusMessage) =>
        m.text?.includes(QA_TWO_WAVE_OBSERVED_FINAL_MARKER),
      );
      expect(finalsWithMarker).toHaveLength(1);

      // Step 10: post-final quiet window
      await transport.waitForNoOutbound({
        sinceIndex: outboundAfterFinal,
        quietMs: 6_000,
      });
      postFinalQuiet = true;
    } catch (error) {
      // Merge transport counts into delivery capture if it exists
      mergeTransportCountsIntoCapture(state, outboundStartIndex);
      const outboundSinceTrigger = state
        .getSnapshot()
        .messages.filter((message: { direction: string }) => message.direction === "outbound")
        .slice(outboundStartIndex);
      // Never persist prompts, session IDs, raw provider output, or channel
      // destinations. The thrown error retains local debugging context only.
      writeSanitizedVerdict({
        schemaVersion: 1,
        phase: "failed",
        wave1SpawnObserved,
        wave1YieldObserved,
        wave1SettleWakeObserved,
        quietDuringBarrier,
        wave2SpawnObserved,
        wave2SettleWakeObserved,
        finalObserved,
        exactlyOneFinalOutbound: false,
        postFinalQuiet,
        qaTransportOutboundTotalSinceTrigger: outboundSinceTrigger.length,
        qaTransportMarkerBearingOutboundCount: outboundSinceTrigger.filter(
          (message: QaBusMessage) => message.text?.includes(QA_TWO_WAVE_OBSERVED_FINAL_MARKER),
        ).length,
        policyOrigin: readPolicyOriginSummary(),
      });
      throw failureContext(error, "two-wave observed proof failed");
    }

    // Merge transport counts into delivery capture (success path)
    mergeTransportCountsIntoCapture(state, outboundStartIndex);

    // Write sanitized verdict (no raw payloads, no credentials)
    const verdict = {
      wave1SpawnObserved,
      wave1YieldObserved,
      wave1SettleWakeObserved,
      quietDuringBarrier,
      wave2SpawnObserved,
      wave2TerminalResumeObserved: wave2SettleWakeObserved,
      wave2SettleWakeObserved,
      finalObserved,
      exactlyOneFinalOutbound: finalObserved,
      postFinalQuiet,
      pass:
        wave1SpawnObserved &&
        wave1YieldObserved &&
        wave1SettleWakeObserved &&
        quietDuringBarrier &&
        wave2SpawnObserved &&
        wave2SettleWakeObserved &&
        finalObserved &&
        postFinalQuiet,
      policyOrigin: readPolicyOriginSummary(),
    };
    writeFileSync(
      "/tmp/oc-129635-continuation-proof/verdict.json",
      JSON.stringify(verdict, null, 2),
    );
  }, 120_000);
});
