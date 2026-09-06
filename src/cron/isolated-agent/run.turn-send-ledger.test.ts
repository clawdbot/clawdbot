// Proves the cron logical-run terminal releases the per-turn send budget even when a
// candidate's own CLI settlement was bypassed — a deferred non-final fallback failure —
// so the next scheduled turn, which reuses the durable session id as its runId
// (run-executor.ts), starts with a fresh budget instead of an inherited cap/nudge.
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildTurnSendLedgerSessionKey,
  commitTurnSend,
  peekTurnSendCount,
  reserveTurnSend,
  resetTurnSendLedgerForTest,
} from "../../agents/tools/turn-send-ledger.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  resolveCronDeliveryPlanMock,
  resolveCronPayloadOutcomeMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const targetKey = "imessage default +15550001111";

function mockCleanAnnounceOutcome(): void {
  resolveCronDeliveryPlanMock.mockReturnValue({
    requested: true,
    mode: "announce",
    channel: "messagechat",
    to: "test-target",
  });
  resolveCronPayloadOutcomeMock.mockReturnValue({
    summary: undefined,
    outputText: undefined,
    synthesizedText: undefined,
    deliveryPayload: undefined,
    deliveryPayloads: [],
    deliveryDisposition: { kind: "visible" },
    deliveryPayloadHasStructuredContent: false,
    hasFatalErrorPayload: false,
    hasFatalStructuredErrorPayload: false,
    embeddedRunError: undefined,
  });
}

describe("runCronIsolatedAgentTurn — per-turn send ledger terminal cleanup", () => {
  setupRunCronIsolatedAgentTurnSuite();

  beforeEach(() => {
    resetTurnSendLedgerForTest();
  });

  it("clears the send budget at the cron terminal so a reused runId starts fresh", async () => {
    let ledgerKey: { sessionKey: string; runId: string; targetKey: string } | undefined;
    // The loopback message tool commits under the canonical grant slot during the run.
    // runWithModelFallback is mocked here, so the per-candidate CLI settlement never runs
    // — only the cron logical-run terminal in run.ts can release this slot.
    runWithModelFallbackMock.mockImplementationOnce(
      async (params: {
        cfg: unknown;
        agentId: string;
        sessionKey?: string;
        runId: string;
        provider: string;
        model: string;
      }) => {
        const grantSessionKey = canonicalizeMainSessionAlias({
          cfg: params.cfg as never,
          agentId: params.agentId,
          sessionKey: params.sessionKey?.trim() || "main",
        });
        ledgerKey = {
          sessionKey: buildTurnSendLedgerSessionKey(params.agentId, grantSessionKey)!,
          runId: params.runId,
          targetKey,
        };
        const reserved = reserveTurnSend(ledgerKey, {});
        if (reserved.status === "reserved") {
          commitTurnSend(reserved.reservation);
        }
        return {
          result: { payloads: [], meta: { agentMeta: { usage: { input: 1, output: 1 } } } },
          provider: params.provider,
          model: params.model,
          attempts: [],
        };
      },
    );
    mockCleanAnnounceOutcome();

    await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(ledgerKey).toBeDefined();
    // The cron terminal deleted exactly the committed slot; a reused runId starts at 0.
    expect(peekTurnSendCount(ledgerKey!)).toBe(0);
  });
});
