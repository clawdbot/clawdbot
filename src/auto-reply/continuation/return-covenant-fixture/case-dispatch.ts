import { randomBytes } from "node:crypto";
import path from "node:path";
import { createContinueDelegateTool } from "../../../agents/tools/continue-delegate-tool.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { deferSessionDelivery } from "../../../infra/session-delivery-queue-storage.js";
import { removeSystemEvents } from "../../../infra/system-events.js";
import { handleContinuationSignal } from "../../reply/agent-runner-continuation-signal.js";
import { createReplyContinuationController } from "../../reply/agent-runner-continuation.js";
import type { FollowupRun } from "../../reply/queue.js";
import {
  decodeDelegateFlow,
  delegateFlowRecords,
  isPostCompactionDelegateFlow,
} from "../delegate-flow-store.js";
import { claimStagedPostCompactionTaskFlowDelegates } from "../delegate-store-post-compaction.js";
import { consumePendingDelegates, markPendingDelegateSpawnAccepted } from "../delegate-store.js";
import {
  continuationRecipientAuthorityMap,
  parseContinuationRecipientAuthorityBinding,
} from "../recipient-authority-binding.js";
import { extractContinuationSignal } from "../signal.js";
import { enqueueContinuationReturnDeliveries } from "../targeting.js";
import type { PendingContinuationDelegate } from "../types.js";
import { materializeReturnCovenantChild } from "./case-setup.js";
import {
  returnCovenantReceiptId,
  type ReturnCovenantAcceptanceReceipt,
  type ReturnCovenantCaseState,
  type ReturnCovenantFixtureContext,
} from "./case-state.js";

const HOLD_WINDOW_MS = 60 * 60 * 1000;

function stateDirectory(context: ReturnCovenantFixtureContext): string {
  const stateDir = context.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("return-covenant fixture lost its isolated state directory");
  }
  return stateDir;
}

function makeFollowupRun(params: {
  context: ReturnCovenantFixtureContext;
  sessionId: string;
  sessionKey: string;
}): FollowupRun {
  const stateDir = stateDirectory(params.context);
  return {
    prompt: "",
    summaryLine: "return-covenant bracket fixture",
    enqueuedAt: params.context.clock.wallNow(),
    run: {
      agentId: "proof",
      agentDir: path.join(stateDir, "agents", "proof", "agent"),
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: path.join(stateDir, "return-covenant-session.jsonl"),
      workspaceDir: process.cwd(),
      config: params.context.config,
      provider: "openai",
      model: "gpt-5.6-luna",
      timeoutMs: 30_000,
      blockReplyBreak: "message_end",
      skipProviderRuntimeHints: true,
    },
  };
}

export function returnCovenantAuthorityFromDelegate(
  delegate: PendingContinuationDelegate,
  sessionKey: string,
) {
  const parsed = parseContinuationRecipientAuthorityBinding(delegate.recipientAuthorityBinding);
  if (parsed.state !== "valid" || parsed.binding.selection !== "selected") {
    throw new Error("accepted delegate did not persist selected recipient authority");
  }
  const recipient = parsed.binding.recipients.find((entry) => entry.sessionKey === sessionKey);
  if (!recipient) {
    throw new Error("accepted delegate authority omitted its logical recipient");
  }
  return recipient.authority;
}

async function invokeReturnCovenantDelegateForm(params: {
  context: ReturnCovenantFixtureContext;
  state: ReturnCovenantCaseState;
}): Promise<void> {
  const { context, state } = params;
  const task = `Return-covenant held completion for ${state.casePlan.id}/${state.form}`;
  if (state.form === "typed-tool") {
    const tool = createContinueDelegateTool({
      agentSessionKey: state.casePlan.logicalSessionKey,
      runId: context.plan.runId,
    });
    await tool.execute(returnCovenantReceiptId("tool-call", state.caseHandle), {
      task,
      mode: state.casePlan.returnMode,
      targetSessionKey: state.casePlan.logicalSessionKey,
    });
    return;
  }

  const raw =
    `fixture output\n[[CONTINUE_DELEGATE: ${task} | ` +
    `target=${state.casePlan.logicalSessionKey} | ${state.casePlan.returnMode}]]`;
  const payloads = [{ text: raw }];
  const extracted = extractContinuationSignal({
    payloads,
    enabled: true,
    sessionKey: state.casePlan.logicalSessionKey,
  });
  if (extracted.signal?.kind !== "delegate" || !extracted.fromBracket) {
    throw new Error("bracket continuation form did not parse as a delegate");
  }
  let activeEntry = loadSessionEntry({
    agentId: "proof",
    env: context.env,
    sessionKey: state.casePlan.logicalSessionKey,
    storePath: context.storePath,
  });
  const controller = createReplyContinuationController({
    cfg: context.config,
    sessionKey: state.casePlan.logicalSessionKey,
    storePath: context.storePath,
    isContinuationWake: false,
    activeSessionStore: undefined,
    getActiveSessionEntry: () => activeEntry,
    setActiveSessionEntry: (entry) => {
      activeEntry = entry;
    },
  });
  await handleContinuationSignal({
    cfg: context.config,
    sessionKey: state.casePlan.logicalSessionKey,
    followupRun: makeFollowupRun({
      context,
      sessionId: state.preSessionId ?? state.postSessionId,
      sessionKey: state.casePlan.logicalSessionKey,
    }),
    runId: context.plan.runId,
    usage: { input: 1, output: 1 },
    effectiveContinuationSignal: extracted.signal,
    continuationExtractionFromBracket: true,
    effectiveContinueWorkRequests: [],
    continuationWorkReason: undefined,
    internalBracketTraceparent: undefined,
    continuation: controller,
    getActiveSessionEntry: () => activeEntry,
  });
}

export async function enqueueHeldReturnCovenantDelivery(params: {
  context: ReturnCovenantFixtureContext;
  state: ReturnCovenantCaseState;
}): Promise<void> {
  const { context, state } = params;
  const parsed = parseContinuationRecipientAuthorityBinding(
    state.delegate?.recipientAuthorityBinding,
  );
  if (parsed.state !== "valid") {
    throw new Error("held result has no durable recipient binding");
  }
  const result = await enqueueContinuationReturnDeliveries({
    targetSessionKeys: [state.casePlan.logicalSessionKey],
    text: state.resultText,
    idempotencyKeyBase: `return-covenant:${context.plan.runId}:${state.casePlan.id}:${state.form}`,
    recipientAuthorities: continuationRecipientAuthorityMap(parsed.binding, [
      state.casePlan.logicalSessionKey,
    ]),
    wakeRecipients: false,
    childRunId: state.delegate?.flowId,
    stateDir: stateDirectory(context),
  });
  if (result.deliveryIds.length !== 1 || result.delivered !== 1) {
    throw new Error("held result did not create exactly one authority-bound delivery");
  }
  const [deliveryId] = result.deliveryIds;
  if (!deliveryId) {
    throw new Error("held result delivery id is missing");
  }
  state.deliveryId = deliveryId;
  await deferSessionDelivery(deliveryId, HOLD_WINDOW_MS, stateDirectory(context));
  const keepSilentEvent =
    state.casePlan.kind === "allowed" && state.casePlan.returnMode === "silent";
  const removed = removeSystemEvents(
    state.casePlan.logicalSessionKey,
    (event) => event.sessionDeliveryAckId !== deliveryId || !keepSilentEvent,
  );
  if (!keepSilentEvent && !removed.some((event) => event.sessionDeliveryAckId === deliveryId)) {
    throw new Error("held result could not remove its pre-release in-memory event");
  }
}

export async function dispatchReturnCovenantCase(params: {
  context: ReturnCovenantFixtureContext;
  state: ReturnCovenantCaseState;
}): Promise<ReturnCovenantAcceptanceReceipt> {
  const { context, state } = params;
  const flowIdsBefore = new Set(
    delegateFlowRecords.listForOwner(state.casePlan.logicalSessionKey).map((flow) => flow.flowId),
  );
  await invokeReturnCovenantDelegateForm(params);
  const newFlows = delegateFlowRecords
    .listForOwner(state.casePlan.logicalSessionKey)
    .filter((flow) => !flowIdsBefore.has(flow.flowId));
  if (newFlows.length !== 1) {
    throw new Error(`delegate form created ${newFlows.length} flow rows instead of one`);
  }
  const [flow] = newFlows;
  let delegate: PendingContinuationDelegate | undefined;
  if (state.casePlan.returnMode === "post-compaction") {
    if (!flow || !isPostCompactionDelegateFlow(flow) || flow.status !== "queued") {
      throw new Error("post-compaction form did not stage one queued flow");
    }
    delegate = decodeDelegateFlow(flow);
  } else {
    delegate = consumePendingDelegates(state.casePlan.logicalSessionKey, {
      ignoreDelay: true,
    }).find((entry) => entry.flowId === flow?.flowId);
  }
  if (!delegate?.flowId || delegate.expectedRevision === undefined) {
    throw new Error("accepted delegate did not expose durable flow ownership");
  }
  state.delegate = delegate;
  const capturedAuthority = returnCovenantAuthorityFromDelegate(
    delegate,
    state.casePlan.logicalSessionKey,
  );
  const acceptance: ReturnCovenantAcceptanceReceipt = {
    caseHandle: state.caseHandle,
    prepareReceiptId: state.database.canonicalFixtureReceiptId,
    accepted: true,
    completionHeld: true,
    receiptId: returnCovenantReceiptId("dispatch", {
      flowId: delegate.flowId,
      key: state.caseHandle,
    }),
    heldResultId: returnCovenantReceiptId("held-result", {
      flowId: delegate.flowId,
    }),
    capturedAuthorityGeneration: capturedAuthority.epoch,
    resultMarker: `RCV-${randomBytes(16).toString("hex")}`,
    originEvidence: {
      source: "product-owned",
      observedForm: state.form,
      receiptId: delegate.flowId,
      typedToolExecutions: state.form === "typed-tool" ? 1 : 0,
      bracketParses: state.form === "bracket-token" ? 1 : 0,
      rawFinalText: state.form === "bracket-token",
    },
  };
  state.acceptance = acceptance;
  if (state.casePlan.returnMode !== "post-compaction") {
    await materializeReturnCovenantChild({ context, state });
    if (
      !state.childSessionKey ||
      !markPendingDelegateSpawnAccepted(delegate, state.childSessionKey, {
        requireWriteSuccess: true,
      })
    ) {
      throw new Error("accepted delegate flow did not commit its child session");
    }
    await enqueueHeldReturnCovenantDelivery(params);
  }
  return acceptance;
}

export async function acceptPostCompactionReturnCovenantCase(params: {
  context: ReturnCovenantFixtureContext;
  state: ReturnCovenantCaseState;
}): Promise<void> {
  const { context, state } = params;
  const flowId = state.delegate?.flowId;
  const claimed = claimStagedPostCompactionTaskFlowDelegates(state.casePlan.logicalSessionKey).find(
    (delegate) => delegate.flowId === flowId,
  );
  if (!claimed) {
    throw new Error("compaction did not release the staged delegate");
  }
  state.delegate = claimed;
  await materializeReturnCovenantChild({ context, state });
  if (
    !state.childSessionKey ||
    !markPendingDelegateSpawnAccepted(claimed, state.childSessionKey, {
      requireWriteSuccess: true,
    })
  ) {
    throw new Error("post-compaction delegate handoff did not persist");
  }
}
