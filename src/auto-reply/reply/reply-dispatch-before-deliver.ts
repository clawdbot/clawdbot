import { copyReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type {
  ReplyDispatchBeforeDeliver,
  ReplyDispatchBeforeDeliverOptions,
  ReplyDispatchRuntimeInfo,
} from "./reply-dispatcher.types.js";

export const DEFAULT_BEFORE_DELIVER_TIMEOUT_MS = 15_000;

type ReplyDispatchBeforeDeliverStage = { hook: ReplyDispatchBeforeDeliver; timeoutMs?: number };

type ReplyDispatchBeforeDeliverStageInput =
  | ReplyDispatchBeforeDeliver
  | { hook: ReplyDispatchBeforeDeliver; options?: ReplyDispatchBeforeDeliverOptions }
  | undefined;

const stagesByHook = new WeakMap<
  ReplyDispatchBeforeDeliver,
  readonly ReplyDispatchBeforeDeliverStage[]
>();

function resolveTimeoutMs(options: ReplyDispatchBeforeDeliverOptions | undefined): number {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_BEFORE_DELIVER_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("beforeDeliver timeoutMs must be a positive finite number");
  }
  return timeoutMs;
}

export async function runReplyDispatchBeforeDeliverStage(
  stage: ReplyDispatchBeforeDeliverStage,
  payload: ReplyPayload,
  info: ReplyDispatchRuntimeInfo,
): Promise<ReplyPayload | null> {
  if (!stage.timeoutMs) {
    return await stage.hook(payload, info);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`beforeDeliver timed out after ${stage.timeoutMs}ms`)),
      stage.timeoutMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve(stage.hook(payload, info)), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function resolveStages(
  input: ReplyDispatchBeforeDeliverStageInput,
): readonly ReplyDispatchBeforeDeliverStage[] {
  if (!input) {
    return [];
  }
  if (typeof input === "function") {
    return (
      stagesByHook.get(input) ?? [{ hook: input, timeoutMs: DEFAULT_BEFORE_DELIVER_TIMEOUT_MS }]
    );
  }
  return (
    stagesByHook.get(input.hook) ?? [
      { hook: input.hook, timeoutMs: resolveTimeoutMs(input.options) },
    ]
  );
}

export function composeReplyDispatchBeforeDeliver(
  ...hooks: ReplyDispatchBeforeDeliverStageInput[]
): ReplyDispatchBeforeDeliver | undefined {
  const stages = hooks.flatMap(resolveStages);
  if (stages.length === 0) {
    return undefined;
  }
  const composed: ReplyDispatchBeforeDeliver = async (payload, info) => {
    let current: ReplyPayload | null = payload;
    for (const stage of stages) {
      if (!current) {
        return null;
      }
      const next = await runReplyDispatchBeforeDeliverStage(stage, current, info);
      current = next ? copyReplyPayloadMetadata(current, next) : null;
    }
    return current;
  };
  stagesByHook.set(composed, stages);
  return composed;
}

export function markReplyDispatchBeforeDeliverDeadlineOwned(
  hook: ReplyDispatchBeforeDeliver,
): ReplyDispatchBeforeDeliver {
  stagesByHook.set(hook, [{ hook }]);
  return hook;
}
