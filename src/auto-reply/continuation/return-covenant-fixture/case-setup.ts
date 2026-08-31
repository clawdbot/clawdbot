import { randomBytes } from "node:crypto";
import {
  appendTranscriptMessage,
  assignSessionOwner,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../../config/sessions/session-sharing-store.js";
import { bindGenericCurrentConversation } from "../../../infra/outbound/current-conversation-bindings.js";
import { buildPersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.message.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../../utils/message-channel-constants.js";
import {
  returnCovenantExecutionKey,
  returnCovenantOwnerA,
  returnCovenantReceiptId,
  type ReturnCovenantCaseState,
  type ReturnCovenantFixtureContext,
} from "./case-state.js";
import { bindReturnCovenantDatabaseReceipt } from "./database.js";
import { sha256ReturnCovenant, type ReturnCovenantPhaseRequest } from "./protocol.js";

export function returnCovenantCaseScope(
  state: ReturnCovenantCaseState,
  context: ReturnCovenantFixtureContext,
) {
  return {
    agentId: "proof",
    env: context.env,
    sessionKey: state.casePlan.logicalSessionKey,
    storePath: context.storePath,
  };
}

export function returnCovenantConversation(
  state: ReturnCovenantCaseState,
  context: ReturnCovenantFixtureContext,
) {
  return {
    channel: INTERNAL_MESSAGE_CHANNEL,
    accountId: "return-covenant",
    conversationId: `${context.plan.syntheticChannelKey}:${state.casePlan.id}:${state.form}`,
  };
}

export async function materializeReturnCovenantRecipient(params: {
  context: ReturnCovenantFixtureContext;
  sessionId: string;
  state: ReturnCovenantCaseState;
}): Promise<void> {
  const { context, sessionId, state } = params;
  const scope = returnCovenantCaseScope(state, context);
  await upsertSessionEntryCore(scope, {
    sessionId,
    updatedAt: context.clock.wallNow(),
    createdAt: context.clock.wallNow(),
    createdVia: "internal",
    createdActor: { ...returnCovenantOwnerA, source: "unknown" },
    visibility: "shared",
    modelProvider: "openai",
    model: "gpt-5.6-luna",
  });
  if (state.casePlan.id === "forbidden-owner-reassignment") {
    assignSessionOwner(scope, {
      owner: returnCovenantOwnerA,
      assignedBy: returnCovenantOwnerA,
      assignedAt: context.clock.wallNow(),
    });
  }
  if (state.casePlan.id === "forbidden-member-access-removal") {
    const added = addSessionMember(scope, {
      identityId: "return-covenant-member",
      addedBy: returnCovenantOwnerA.id,
      addedAt: context.clock.wallNow(),
      expectedSessionId: sessionId,
    });
    if (!added.inserted) {
      throw new Error("return-covenant fixture member was already present");
    }
  }
  const binding = await bindGenericCurrentConversation({
    targetSessionKey: state.casePlan.logicalSessionKey,
    targetKind: "session",
    conversation: returnCovenantConversation(state, context),
    metadata: { runId: context.plan.runId },
  });
  if (!binding) {
    throw new Error("return-covenant synthetic conversation binding was not persisted");
  }
}

export async function materializeReturnCovenantChild(params: {
  context: ReturnCovenantFixtureContext;
  state: ReturnCovenantCaseState;
}): Promise<void> {
  const { context, state } = params;
  const flowId = state.delegate?.flowId;
  if (!flowId) {
    throw new Error("cannot materialize a child without a claimed delegate flow");
  }
  const childSessionKey = `agent:proof:subagent:${sha256ReturnCovenant(flowId).slice(0, 24)}`;
  await upsertSessionEntryCore(
    {
      agentId: "proof",
      env: context.env,
      sessionKey: childSessionKey,
      storePath: context.storePath,
    },
    {
      sessionId: returnCovenantReceiptId("child-session", flowId),
      updatedAt: context.clock.wallNow(),
      createdAt: context.clock.wallNow(),
      createdVia: "spawn",
      parentSessionKey: state.casePlan.logicalSessionKey,
      spawnedBy: state.casePlan.logicalSessionKey,
      status: "running",
    },
  );
  state.childSessionKey = childSessionKey;
}

export async function createPreparedReturnCovenantCase(params: {
  context: ReturnCovenantFixtureContext;
  request: Extract<ReturnCovenantPhaseRequest, { phase: "prepare" }>;
}): Promise<ReturnCovenantCaseState> {
  const { context, request } = params;
  const casePlan = context.plan.cases.find((entry) => entry.id === request.caseId);
  if (!casePlan) {
    throw new Error(`planned return-covenant case is missing: ${request.caseId}`);
  }
  const key = returnCovenantExecutionKey(request.caseId, request.form);
  const caseHandle = `case-${sha256ReturnCovenant(
    `${context.plan.runId}:${key}:${randomBytes(16).toString("hex")}`,
  ).slice(0, 40)}`;
  const preSessionId =
    request.caseId === "allowed-late-materialization"
      ? null
      : returnCovenantReceiptId("session-before", { caseHandle });
  const state: ReturnCovenantCaseState = {
    caseHandle,
    casePlan,
    closed: false,
    database: bindReturnCovenantDatabaseReceipt({
      caseHandle,
      profiles: context.profiles,
      profile: request.databaseProfile,
      runId: context.plan.runId,
    }),
    form: request.form,
    phase: "prepared",
    postSessionId: returnCovenantReceiptId("session-after", { caseHandle }),
    preSessionId,
    request,
    resultText: `[Internal task completion event] Return-covenant result for ${key}.`,
    startedAt: new Date(context.clock.wallNow()).toISOString(),
    wakeCount: 0,
  };
  if (preSessionId) {
    await materializeReturnCovenantRecipient({ context, sessionId: preSessionId, state });
    await appendTranscriptMessage(
      {
        ...returnCovenantCaseScope(state, context),
        sessionId: preSessionId,
      },
      {
        message: buildPersistedUserTurnMessage({
          text: `Return-covenant pre-transition fixture for ${key}.`,
          timestamp: context.clock.wallNow(),
        }),
      },
    );
  }
  return state;
}
