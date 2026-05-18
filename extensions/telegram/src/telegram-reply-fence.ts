import { isAbortRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";

type TelegramReplyFenceState = {
  generation: number;
  activeDispatches: number;
  abortControllers?: Set<AbortController>;
  laneKeys?: Set<string>;
};

export type TelegramReplyFenceKey = {
  activeKey: string;
  roomEventKey: string;
};

// Newer accepted turns and authorized aborts can arrive ahead of older same-session reply work.
const telegramReplyFenceByKey = new Map<string, TelegramReplyFenceState>();
const telegramReplyFenceKeysByLane = new Map<string, Set<string>>();

export function buildTelegramReplyFenceLaneKey(params: {
  accountId: string;
  sequentialKey: string;
}): string {
  return `${params.accountId}\0${params.sequentialKey}`;
}

function normalizeTelegramFenceKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveTelegramReplyFenceKey(params: {
  ctxPayload: { SessionKey?: string; CommandTargetSessionKey?: string; InboundEventKind?: string };
  chatId: number | string;
  threadSpec: { id?: number | string | null; scope?: string };
}): TelegramReplyFenceKey {
  const baseKey =
    normalizeTelegramFenceKey(params.ctxPayload.CommandTargetSessionKey) ??
    normalizeTelegramFenceKey(params.ctxPayload.SessionKey) ??
    `telegram:${String(params.chatId)}:${params.threadSpec.scope ?? "default"}:${params.threadSpec.id ?? "root"}`;
  const roomEventKey = `${baseKey}:room_event`;
  return {
    activeKey: params.ctxPayload.InboundEventKind === "room_event" ? roomEventKey : baseKey,
    roomEventKey,
  };
}

function abortTelegramReplyFenceControllers(state: TelegramReplyFenceState): void {
  for (const controller of state.abortControllers ?? []) {
    controller.abort();
  }
  state.abortControllers?.clear();
}

function deleteTelegramReplyFenceState(key: string, state: TelegramReplyFenceState): void {
  telegramReplyFenceByKey.delete(key);
  for (const laneKey of state.laneKeys ?? []) {
    const keys = telegramReplyFenceKeysByLane.get(laneKey);
    keys?.delete(key);
    if (keys?.size === 0) {
      telegramReplyFenceKeysByLane.delete(laneKey);
    }
  }
}

function maybeDeleteTelegramReplyFenceState(key: string, state: TelegramReplyFenceState): void {
  if (state.activeDispatches <= 0 && (state.abortControllers?.size ?? 0) === 0) {
    deleteTelegramReplyFenceState(key, state);
  } else {
    telegramReplyFenceByKey.set(key, state);
  }
}

export function beginTelegramReplyFence(params: {
  key: string;
  supersede: boolean;
  abortController?: AbortController;
  laneKey?: string;
}): number {
  const existing = telegramReplyFenceByKey.get(params.key);
  const state: TelegramReplyFenceState = existing ?? {
    generation: 0,
    activeDispatches: 0,
  };
  if (params.supersede) {
    state.generation += 1;
    abortTelegramReplyFenceControllers(state);
  }
  if (params.abortController) {
    (state.abortControllers ??= new Set()).add(params.abortController);
  }
  const laneKey = normalizeTelegramFenceKey(params.laneKey);
  if (laneKey) {
    (state.laneKeys ??= new Set()).add(laneKey);
    const keys = telegramReplyFenceKeysByLane.get(laneKey) ?? new Set<string>();
    keys.add(params.key);
    telegramReplyFenceKeysByLane.set(laneKey, keys);
  }
  state.activeDispatches += 1;
  telegramReplyFenceByKey.set(params.key, state);
  return state.generation;
}

export function supersedeTelegramReplyFence(key: string): boolean {
  const state = telegramReplyFenceByKey.get(key);
  if (!state) {
    return false;
  }
  state.generation += 1;
  abortTelegramReplyFenceControllers(state);
  maybeDeleteTelegramReplyFenceState(key, state);
  return true;
}

export function supersedeTelegramReplyFenceLane(laneKey: string): boolean {
  const keys = [...(telegramReplyFenceKeysByLane.get(laneKey) ?? [])];
  let superseded = false;
  for (const key of keys) {
    superseded = supersedeTelegramReplyFence(key) || superseded;
  }
  return superseded;
}

export function isTelegramReplyFenceSuperseded(params: {
  key: string;
  generation: number;
}): boolean {
  return (telegramReplyFenceByKey.get(params.key)?.generation ?? 0) !== params.generation;
}

export function endTelegramReplyFence(key: string, abortController?: AbortController): void {
  const state = telegramReplyFenceByKey.get(key);
  if (!state) {
    return;
  }
  if (abortController) {
    state.abortControllers?.delete(abortController);
  }
  state.activeDispatches = Math.max(0, state.activeDispatches - 1);
  maybeDeleteTelegramReplyFenceState(key, state);
}

export function releaseTelegramReplyFenceAbortController(
  key: string,
  abortController?: AbortController,
): void {
  if (!abortController) {
    return;
  }
  const state = telegramReplyFenceByKey.get(key);
  if (!state) {
    return;
  }
  state.abortControllers?.delete(abortController);
  maybeDeleteTelegramReplyFenceState(key, state);
}

export function shouldSupersedeTelegramReplyFence(ctxPayload: {
  Body?: string;
  RawBody?: string;
  CommandBody?: string;
  CommandAuthorized: boolean;
}): boolean {
  const dispatchText = ctxPayload.CommandBody ?? ctxPayload.RawBody ?? ctxPayload.Body ?? "";
  return !isAbortRequestText(dispatchText) || ctxPayload.CommandAuthorized;
}

export function getTelegramReplyFenceSizeForTests(): number {
  return telegramReplyFenceByKey.size;
}

export function resetTelegramReplyFenceForTests(): void {
  telegramReplyFenceByKey.clear();
  telegramReplyFenceKeysByLane.clear();
}
