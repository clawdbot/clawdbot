import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import type {
  PluginHookMessageContext,
  PluginHookMessageSendingEvent,
} from "../plugins/hook-types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { TurnAdoptionLifecycle } from "./get-reply-options.types.js";
import type { FinalizedMsgContext } from "./templating.js";
import { isSilentReplyPayloadText } from "./tokens.js";
import type { ReplyPayload } from "./types.js";

export type GroupThreadParticipant = { agentId: string; name: string };
export type GroupThreadTurn = GroupThreadParticipant & {
  round: number;
  messageId: string;
  digest?: string;
};

type GroupThreadRunState = {
  runId?: string;
  executionIdentityToken?: ExecutionIdentityAdmissionToken;
};

type GroupThreadScope = {
  turn: GroupThreadTurn;
  participant?: GroupThreadParticipant;
  recordReply: (payload: ReplyPayload) => void;
  formatReply?: (text: string, participant: GroupThreadParticipant) => string;
  adopt?: (lifecycle: TurnAdoptionLifecycle) => Promise<void>;
  dispatch?: { ctx: FinalizedMsgContext; runState: GroupThreadRunState };
};

const turns = resolveGlobalSingleton(
  Symbol.for("openclaw.groupThreadContext"),
  () => new AsyncLocalStorage<GroupThreadScope & { active: boolean }>(),
);

type ToolReplySource = {
  matches: (event: PluginHookMessageSendingEvent, context: PluginHookMessageContext) => boolean;
  format: (text: string) => string;
};
type ToolReplyCapture = {
  active: boolean;
  observed: boolean;
  text?: string;
  source?: ToolReplySource;
};
const toolReplies = resolveGlobalSingleton(
  Symbol.for("openclaw.groupThreadToolReplies"),
  () => new AsyncLocalStorage<ToolReplyCapture>(),
);

export async function captureGroupThreadToolReply<T>(
  run: () => Promise<T>,
  source?: ToolReplySource,
): Promise<{ result: T; observed: boolean; text?: string }> {
  if (!currentScope()) {
    return { result: await run(), observed: false };
  }
  const capture: ToolReplyCapture = { active: true, observed: false, source };
  return toolReplies.run(capture, async () => {
    try {
      const result = await run();
      return { result, observed: capture.observed, text: capture.text };
    } finally {
      capture.active = false;
    }
  });
}

/** Restore source attribution after modifying hooks; undefined preserves cancellation. */
export function finalizeGroupThreadToolReply(
  text: string | undefined,
  event: PluginHookMessageSendingEvent,
  context: PluginHookMessageContext,
): string | undefined {
  const capture = toolReplies.getStore();
  let content = text;
  if (
    capture?.active &&
    currentScope() &&
    (!capture.source || capture.source.matches(event, context))
  ) {
    if (content?.trim() && !isSilentReplyPayloadText(content)) {
      content = capture.source?.format(content) ?? content;
    }
    capture.observed = true;
    capture.text = content?.slice(0, 4_000);
  }
  return content;
}

export function withGroupThreadTurn<T>(scope: GroupThreadScope, run: () => Promise<T>): Promise<T> {
  const owned = { ...scope, active: true };
  return turns.run(owned, async () => {
    try {
      return await run();
    } finally {
      owned.active = false;
    }
  });
}

function currentScope(): GroupThreadScope | undefined {
  const scope = turns.getStore();
  return scope?.active ? scope : undefined;
}

export function getGroupThreadTurn(): GroupThreadTurn | undefined {
  return currentScope()?.turn;
}

export function getGroupThreadParticipant(): GroupThreadParticipant | undefined {
  return currentScope()?.participant;
}

export async function adoptGroupThreadRoot(
  lifecycle: TurnAdoptionLifecycle | undefined,
): Promise<void> {
  if (lifecycle) {
    await currentScope()?.adopt?.(lifecycle);
  }
}

export function bindGroupThreadDispatchContext(ctx: FinalizedMsgContext): GroupThreadRunState {
  const runState: GroupThreadRunState = {};
  const scope = currentScope();
  if (scope) {
    scope.dispatch = { ctx, runState };
  }
  return runState;
}

export function getGroupThreadDispatchContext(): GroupThreadScope["dispatch"] {
  return currentScope()?.dispatch;
}

export function recordGroupThreadReply(payload: ReplyPayload): void {
  currentScope()?.recordReply(payload);
}

/** Message actions use the initiating channel's encoder, without changing delivery ownership. */
export function formatGroupThreadReply(text: string): string {
  const scope = currentScope();
  if (!scope?.participant || !scope.formatReply) {
    return text;
  }
  const label = scope.formatReply("", scope.participant);
  return label && text.startsWith(label) ? text : scope.formatReply(text, scope.participant);
}
