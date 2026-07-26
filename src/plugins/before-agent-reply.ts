import { AsyncLocalStorage } from "node:async_hooks";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { runOncePerAgentRun } from "../infra/agent-events.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getGlobalHookRunner } from "./hook-runner-global.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentReplyEvent,
  PluginHookBeforeAgentReplyResult,
} from "./hook-types.js";

const BEFORE_AGENT_REPLY_TRIGGERS = new Set(["user", "heartbeat", "cron"]);
const BEFORE_AGENT_REPLY_OBSERVER_KEY = Symbol.for("openclaw.beforeAgentReply.observer");

type BeforeAgentReplyObserver = {
  beforeDispatch: () => Promise<boolean | void>;
  afterDispatch: (
    result: PluginHookBeforeAgentReplyResult | undefined,
  ) => Promise<PluginHookBeforeAgentReplyResult | undefined>;
};

type BeforeAgentReplyObserverScope = BeforeAgentReplyObserver & { runId?: string };

const beforeAgentReplyObserver = resolveGlobalSingleton<
  AsyncLocalStorage<BeforeAgentReplyObserverScope>
>(BEFORE_AGENT_REPLY_OBSERVER_KEY, () => new AsyncLocalStorage());

/** Attaches durable admission bookkeeping without moving hook ownership out of the runner. */
export function withBeforeAgentReplyObserver<T>(
  observer: BeforeAgentReplyObserver,
  run: () => T,
): T {
  return beforeAgentReplyObserver.run({ ...observer }, run);
}

/** Preserves the full plugin reply contract, including private payload metadata. */
export function buildHandledBeforeAgentReplyPayloads(reply?: ReplyPayload): ReplyPayload[] {
  return [reply ?? { text: SILENT_REPLY_TOKEN }];
}

/** Runs the reply claim hook once for one admitted turn, across model fallbacks. */
export function runBeforeAgentReplyForTurn(params: {
  runId: string;
  trigger?: string;
  event: PluginHookBeforeAgentReplyEvent;
  context: PluginHookAgentContext;
  onDispatch?: () => void;
  onDeclined?: () => void;
}): Promise<PluginHookBeforeAgentReplyResult | undefined> {
  if (!params.trigger || !BEFORE_AGENT_REPLY_TRIGGERS.has(params.trigger)) {
    return Promise.resolve(undefined);
  }
  return runOncePerAgentRun(params.runId, "before_agent_reply", async () => {
    const hookRunner = getGlobalHookRunner();
    if (!hookRunner?.hasHooks("before_agent_reply")) {
      return undefined;
    }
    const observerScope = beforeAgentReplyObserver.getStore();
    // Nested agent runs inherit async context. Bind recovery to the first runner
    // so a hook-spawned child cannot checkpoint its parent's admitted turn.
    const observer =
      observerScope && (!observerScope.runId || observerScope.runId === params.runId)
        ? observerScope
        : undefined;
    if (observer && !observer.runId) {
      observer.runId = params.runId;
    }
    if ((await observer?.beforeDispatch()) === false) {
      return undefined;
    }
    params.onDispatch?.();
    let result = await hookRunner.runBeforeAgentReply(params.event, params.context);
    if (!result?.handled) {
      params.onDeclined?.();
    }
    if (observer) {
      result = await observer.afterDispatch(result);
    }
    return result;
  });
}
