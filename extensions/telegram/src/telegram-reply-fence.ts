// Telegram plugin module implements telegram reply fence behavior.
import {
  isExplicitCommandTurn,
  type CommandTurnContext,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  maybeResolveTextAlias,
  normalizeCommandBody,
} from "openclaw/plugin-sdk/command-auth-native";
import {
  isAbortRequestText,
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
import { isTelegramReadOnlyControlLaneText } from "./sequential-key.js";

type TelegramReplyFenceState = {
  generation: number;
  activeDispatches: number;
  abortControllers?: Set<AbortController>;
  laneKeys?: Set<string>;
};

type TelegramReplyFenceKey = {
  activeKey: string;
  roomEventKey: string;
};

// Newer accepted turns and authorized aborts can arrive ahead of older same-session reply work.
const TELEGRAM_REPLY_FENCE_STATE_KEY = Symbol.for("openclaw.telegram.replyFenceState");

function getTelegramReplyFenceState(): {
  byKey: Map<string, TelegramReplyFenceState>;
  keysByLane: Map<string, Set<string>>;
} {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const existing = globalRecord[TELEGRAM_REPLY_FENCE_STATE_KEY] as
    | {
        byKey: Map<string, TelegramReplyFenceState>;
        keysByLane: Map<string, Set<string>>;
      }
    | undefined;
  if (existing) {
    return existing;
  }
  const created = {
    byKey: new Map<string, TelegramReplyFenceState>(),
    keysByLane: new Map<string, Set<string>>(),
  };
  globalRecord[TELEGRAM_REPLY_FENCE_STATE_KEY] = created;
  return created;
}

const { byKey: telegramReplyFenceByKey, keysByLane: telegramReplyFenceKeysByLane } =
  getTelegramReplyFenceState();

export function buildTelegramReplyFenceLaneKey(params: {
  accountId: string;
  sequentialKey: string;
}): string {
  return `${params.accountId}\0${params.sequentialKey}`;
}

export function buildTelegramNonInterruptingReplyFenceKey(params: {
  activeKey: string;
  laneKey: string;
}): string {
  return `${buildTelegramNonInterruptingReplyFenceKeyPrefix(params.activeKey)}${params.laneKey}`;
}

function buildTelegramNonInterruptingReplyFenceKeyPrefix(activeKey: string): string {
  return `${activeKey}\0non-interrupting\0`;
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
    supersedeTelegramNonInterruptingReplyFenceChildren(params.key);
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

function supersedeTelegramReplyFenceState(key: string): boolean {
  const state = telegramReplyFenceByKey.get(key);
  if (!state) {
    return false;
  }
  state.generation += 1;
  abortTelegramReplyFenceControllers(state);
  maybeDeleteTelegramReplyFenceState(key, state);
  return true;
}

function supersedeTelegramNonInterruptingReplyFenceChildren(key: string): boolean {
  let superseded = false;
  const childPrefix = buildTelegramNonInterruptingReplyFenceKeyPrefix(key);
  for (const childKey of telegramReplyFenceByKey.keys()) {
    if (childKey.startsWith(childPrefix)) {
      superseded = supersedeTelegramReplyFenceState(childKey) || superseded;
    }
  }
  return superseded;
}

export function supersedeTelegramReplyFence(key: string): boolean {
  let superseded = supersedeTelegramReplyFenceState(key);
  superseded = supersedeTelegramNonInterruptingReplyFenceChildren(key) || superseded;
  return superseded;
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

function isRecognizedTelegramTextCommand(rawText: string): boolean {
  return maybeResolveTextAlias(normalizeCommandBody(rawText)) != null;
}

export function shouldSupersedeTelegramReplyFence(ctxPayload: {
  Body?: string;
  ChatType?: string;
  RawBody?: string;
  CommandBody?: string;
  CommandAuthorized: boolean;
  CommandTurn?: CommandTurnContext;
}): boolean {
  const dispatchText = ctxPayload.CommandBody ?? ctxPayload.RawBody ?? ctxPayload.Body ?? "";
  if (isAbortRequestText(dispatchText)) {
    return ctxPayload.CommandAuthorized;
  }
  if (
    isBtwRequestText(dispatchText) ||
    isTelegramReadOnlyControlLaneText({ rawText: dispatchText })
  ) {
    return false;
  }
  // One rule for all chat types: only authorized explicit/native commands
  // supersede. Normal messages never abort an active turn at the transport
  // fence; core queue policy owns steer/followup/interrupt after adoption.
  return (
    ctxPayload.CommandAuthorized &&
    (isExplicitCommandTurn(ctxPayload.CommandTurn) || isRecognizedTelegramTextCommand(dispatchText))
  );
}
