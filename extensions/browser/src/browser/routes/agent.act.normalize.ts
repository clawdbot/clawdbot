import {
  ACT_MAX_BATCH_ACTIONS,
  ACT_MAX_CLICK_DELAY_MS,
  ACT_MAX_WAIT_TIME_MS,
  normalizeActBoundedNonNegativeMs,
} from "../act-policy.js";
import type { BrowserActRequest, BrowserFormField } from "../client-actions.types.js";
import { normalizeBrowserFormField } from "../form-fields.js";
import {
  type ActKind,
  isActKind,
  parseClickButton,
  parseClickModifiers,
} from "./agent.act.shared.js";
import { toBoolean, toNumber, toStringArray, toStringOrEmpty } from "./utils.js";

function normalizeActKind(raw: unknown): ActKind {
  const kind = toStringOrEmpty(raw);
  if (!isActKind(kind)) {
    throw new Error("kind is required");
  }
  return kind;
}

export function countBatchActions(actions: BrowserActRequest[]): number {
  let count = 0;
  for (const action of actions) {
    count += 1;
    if (action.kind === "batch") {
      count += countBatchActions(action.actions);
    }
  }
  return count;
}

export function validateBatchTargetIds(
  actions: BrowserActRequest[],
  targetId: string,
): string | null {
  for (const action of actions) {
    if (action.targetId && action.targetId !== targetId) {
      return "batched action targetId must match request targetId";
    }
    if (action.kind === "batch") {
      const nestedError = validateBatchTargetIds(action.actions, targetId);
      if (nestedError) {
        return nestedError;
      }
    }
  }
  return null;
}

function normalizeFields(rawFields: unknown): BrowserFormField[] {
  const entries = Array.isArray(rawFields) ? rawFields : [];
  return entries
    .map((field) => {
      if (!field || typeof field !== "object") {
        return null;
      }
      return normalizeBrowserFormField(field as Record<string, unknown>);
    })
    .filter((field): field is BrowserFormField => field !== null);
}

function normalizeBatchAction(value: unknown): BrowserActRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("batch actions must be objects");
  }
  return normalizeActRequest(value as Record<string, unknown>, { source: "batch" });
}

export function normalizeActRequest(
  body: Record<string, unknown>,
  options?: { source?: "request" | "batch" },
): BrowserActRequest {
  const source = options?.source ?? "request";
  const kind = normalizeActKind(body.kind);

  switch (kind) {
    case "click": {
      const ref = toStringOrEmpty(body.ref) || undefined;
      const selector = toStringOrEmpty(body.selector) || undefined;
      if (!ref && !selector) {
        throw new Error("click requires ref or selector");
      }
      const buttonRaw = toStringOrEmpty(body.button);
      const button = buttonRaw ? parseClickButton(buttonRaw) : undefined;
      if (buttonRaw && !button) {
        throw new Error("click button must be left|right|middle");
      }
      const modifiersRaw = toStringArray(body.modifiers) ?? [];
      const parsedModifiers = parseClickModifiers(modifiersRaw);
      if (parsedModifiers.error) {
        throw new Error(parsedModifiers.error);
      }
      const doubleClick = toBoolean(body.doubleClick);
      const delayMs = normalizeActBoundedNonNegativeMs(
        toNumber(body.delayMs),
        "click delayMs",
        ACT_MAX_CLICK_DELAY_MS,
      );
      const timeoutMs = toNumber(body.timeoutMs);
      const targetId = toStringOrEmpty(body.targetId) || undefined;
      return {
        kind,
        ...(ref ? { ref } : {}),
        ...(selector ? { selector } : {}),
        ...(targetId ? { targetId } : {}),
        ...(doubleClick !== undefined ? { doubleClick } : {}),
        ...(button ? { button } : {}),
        ...(parsedModifiers.modifiers ? { modifiers: parsedModifiers.modifiers } : {}),
        ...(delayMs !== undefined ? { delayMs } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case "type": {
      const ref = toStringOrEmpty(body.ref) || undefined;
      const selector = toStringOrEmpty(body.selector) || undefined;
      const text = body.text;
      if (!ref && !selector) {
        throw new Error("type requires ref or selector");
      }
      if (typeof text !== "string") {
        throw new Error("type requires text");
      }
      const targetId = toStringOrEmpty(body.targetId) || undefined;
      const submit = toBoolean(body.submit);
      const slowly = toBoolean(body.slowly);
      const timeoutMs = toNumber(body.timeoutMs);
      return {
        kind,
        ...(ref ? { ref } : {}),
        ...(selector ? { selector } : {}),
        text,
        ...(targetId ? { targetId } : {}),
        ...(submit !== undefined ? { submit } : {}),
        ...(slowly !== undefined ? { slowly } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case "press": {
      const key = toStringOrEmpty(body.key);
      if (!key) {
        throw new Error("press requires key");
      }
      const targetId = toStringOrEmpty(body.targetId) || undefined;
      const delayMs = toNumber(body.delayMs);
      return {
        kind,
        key,
        ...(targetId ? { targetId } : {}),
        ...(delayMs !== undefined ? { delayMs } : {}),
      };
    }
    case "hover":
    case "scrollIntoView": {
      const ref = toStringOrEmpty(body.ref) || undefined;
      const selector = toStringOrEmpty(body.selector) || undefined;
      if (!ref && !selector) {
        throw new Error(`${kind} requires ref or selector`);
      }
      const targetId = toStringOrEmpty(body.targetId) || undefined;
      const timeoutMs = toNumber(body.timeoutMs);
      return {
        kind,
        ...(ref ? { ref } : {}),
        ...(selector ? { selector } : {}),
        ...(targetId ? { targetId } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case "drag": {
      const startRef = toStringOrEmpty(body.startRef) || undefined;
      const startSelector = toStringOrEmpty(body.startSelector) || undefined;
      const endRef = toStringOrEmpty(body.endRef) || undefined;
      const endSelector = toStringOrEmpty(body.endSelector) || undefined;
      if (!startRef && !startSelector) {
        throw new Error("drag requires startRef or startSelector");
      }
      if (!endRef && !endSelector) {
        throw new Error("drag requires endRef or endSelector");
      }
      const targetId = toStringOrEmpty(body.targetId) || undefined;
      const timeoutMs = toNumber(body.timeoutMs);
      return {
        kind,
        ...(startRef ? { startRef } : {}),
        ...(startSelector ? { startSelector } : {}),
        ...(endRef ? { endRef } : {}),
        ...(endSelector ? { endSelector } : {}),
        ...(targetId ? { targetId } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case "select": {
      const ref = toStringOrEmpty(body.ref) || undefined;
      const selector = toStringOrEmpty(body.selector) || undefined;
      const values = toStringArray(body.values);
      if ((!ref && !selector) || !values?.length) {
        throw new Error("select requires ref/selector and values");
      }
      const targetId = toStringOrEmpty(body.targetId) || undefined;
      const timeoutMs = toNumber(body.timeoutMs);
      return {
        kind,
        ...(ref ? { ref } : {}),
        ...(selector ? { selector } : {}),
        values,
        ...(targetId ? { targetId } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case "fill": {
      const fields = normalizeFields(body.fields);
      if (!fields.length) {
        throw new Error("fill requires fields");
      }
      const targetId = toStringOrEmpty(body.targetId) || undefined;
      const timeoutMs = toNumber(body.timeoutMs);
      return {
        kind,
        fields,
        ...(targetId ? { targetId } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case "resize": {
      const width = toNumber(body.width);
      const height = toNumber(body.height);
      if (width === undefined || height === undefined || width <= 0 || height <= 0) {
        throw new Error("resize requires positive width and height");
      }
      const targetId = toStringOrEmpty(body.targetId) || undefined;
      return {
        kind,
        width,
        height,
        ...(targetId ? { targetId } : {}),
      };
    }
    case "wait": {
      const loadStateRaw = toStringOrEmpty(body.loadState);
      const loadState =
        loadStateRaw === "load" ||
        loadStateRaw === "domcontentloaded" ||
        loadStateRaw === "networkidle"
          ? loadStateRaw
          : undefined;
      const timeMs = normalizeActBoundedNonNegativeMs(
        toNumber(body.timeMs),
        "wait timeMs",
        ACT_MAX_WAIT_TIME_MS,
      );
      const text = toStringOrEmpty(body.text) || undefined;
      const textGone = toStringOrEmpty(body.textGone) || undefined;
      const selector = toStringOrEmpty(body.selector) || undefined;
      const url = toStringOrEmpty(body.url) || undefined;
      const fn = toStringOrEmpty(body.fn) || undefined;
      if (timeMs === undefined && !text && !textGone && !selector && !url && !loadState && !fn) {
        throw new Error(
          "wait requires at least one of: timeMs, text, textGone, selector, url, loadState, fn",
        );
      }
      const targetId = toStringOrEmpty(body.targetId) || undefined;
      const timeoutMs = toNumber(body.timeoutMs);
      return {
        kind,
        ...(timeMs !== undefined ? { timeMs } : {}),
        ...(text ? { text } : {}),
        ...(textGone ? { textGone } : {}),
        ...(selector ? { selector } : {}),
        ...(url ? { url } : {}),
        ...(loadState ? { loadState } : {}),
        ...(fn ? { fn } : {}),
        ...(targetId ? { targetId } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case "evaluate": {
      const fn = toStringOrEmpty(body.fn);
      if (!fn) {
        throw new Error("evaluate requires fn");
      }
      const ref = toStringOrEmpty(body.ref) || undefined;
      const targetId = toStringOrEmpty(body.targetId) || undefined;
      const timeoutMs = toNumber(body.timeoutMs);
      return {
        kind,
        fn,
        ...(ref ? { ref } : {}),
        ...(targetId ? { targetId } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case "close": {
      const targetId = toStringOrEmpty(body.targetId) || undefined;
      return {
        kind,
        ...(targetId ? { targetId } : {}),
      };
    }
    case "batch": {
      const actions = Array.isArray(body.actions) ? body.actions.map(normalizeBatchAction) : [];
      if (!actions.length) {
        throw new Error(source === "batch" ? "batch requires actions" : "actions are required");
      }
      if (countBatchActions(actions) > ACT_MAX_BATCH_ACTIONS) {
        throw new Error(`batch exceeds maximum of ${ACT_MAX_BATCH_ACTIONS} actions`);
      }
      const targetId = toStringOrEmpty(body.targetId) || undefined;
      const stopOnError = toBoolean(body.stopOnError);
      return {
        kind,
        actions,
        ...(targetId ? { targetId } : {}),
        ...(stopOnError !== undefined ? { stopOnError } : {}),
      };
    }
  }
  throw new Error("Unsupported browser act kind");
}
