import path from "node:path";
import { isRecord, stableStringify, stableValue } from "./telegram-visible-proof-contract.mjs";

const MATERIAL_TIMING_DELTA_MS = 1_000;
const VISIBLE_KINDS = new Set(["message", "edit", "edit-meta", "delete"]);
const VISIBLE_ACTORS = new Set(["user", "bot"]);

function matchText(value, matcher) {
  if (!matcher) {
    return true;
  }
  const text = typeof value === "string" ? value : "";
  if (matcher.contains !== undefined) {
    return text.includes(matcher.contains);
  }
  if (matcher.equals !== undefined) {
    return text === matcher.equals;
  }
  return new RegExp(matcher.regex, "u").test(text);
}

export function eventMatches(event, match) {
  if (match.kind !== undefined && event.kind !== match.kind) {
    return false;
  }
  if (match.actor !== undefined && event.actor !== match.actor) {
    return false;
  }
  if (match.contentType !== undefined && event.contentType !== match.contentType) {
    return false;
  }
  if (!matchText(event.text, match.text)) {
    return false;
  }
  if (match.buttonText !== undefined) {
    const buttons = Array.isArray(event.buttons) ? event.buttons : [];
    if (!buttons.some((button) => matchText(button?.text, match.buttonText))) {
      return false;
    }
  }
  return true;
}

function firstMatchingIndex(events, match, start = 0) {
  for (let index = start; index < events.length; index += 1) {
    if (eventMatches(events[index], match)) {
      return index;
    }
  }
  return -1;
}

export function evaluateAssertion(events, assertion) {
  if (assertion.type === "count") {
    const count = events.filter((event) => eventMatches(event, assertion.match)).length;
    const passed =
      (assertion.equals === undefined || count === assertion.equals) &&
      (assertion.min === undefined || count >= assertion.min) &&
      (assertion.max === undefined || count <= assertion.max);
    const expected =
      assertion.equals !== undefined
        ? `exactly ${assertion.equals}`
        : `${assertion.min === undefined ? "" : `>= ${assertion.min}`} ${
            assertion.max === undefined ? "" : `<= ${assertion.max}`
          }`.trim();
    return { count, passed, summary: `count ${count}; expected ${expected}` };
  }
  if (assertion.type === "sequence") {
    let cursor = 0;
    const indexes = [];
    for (const step of assertion.steps) {
      const index = firstMatchingIndex(events, step, cursor);
      if (index < 0) {
        return {
          indexes,
          passed: false,
          summary: `matched ${indexes.length}/${assertion.steps.length} ordered steps`,
        };
      }
      indexes.push(index);
      cursor = index + 1;
    }
    return { indexes, passed: true, summary: `matched ${indexes.length} ordered steps` };
  }
  const fromIndex = firstMatchingIndex(events, assertion.from);
  const toIndex = fromIndex < 0 ? -1 : firstMatchingIndex(events, assertion.to, fromIndex + 1);
  const gapMs =
    fromIndex < 0 || toIndex < 0
      ? undefined
      : Math.max(0, Number(events[toIndex].elapsedMs ?? 0) - Number(events[fromIndex].elapsedMs ?? 0));
  const passed =
    gapMs !== undefined &&
    (assertion.minMs === undefined || gapMs >= assertion.minMs) &&
    (assertion.maxMs === undefined || gapMs <= assertion.maxMs);
  return {
    fromIndex,
    gapMs,
    passed,
    summary: gapMs === undefined ? "gap endpoints were not observed" : `gap ${gapMs}ms`,
    toIndex,
  };
}

export function visibleEvents(rawEvents) {
  if (!Array.isArray(rawEvents)) {
    return [];
  }
  return rawEvents.filter(
    (event) =>
      isRecord(event) && VISIBLE_KINDS.has(event.kind) && VISIBLE_ACTORS.has(event.actor),
  );
}

export function normalizeVisibleEvents(events) {
  const ids = new Map();
  let next = 1;
  const idFor = (value) => {
    if (value === undefined || value === null || value === "") {
      return null;
    }
    const key = String(value);
    if (!ids.has(key)) {
      ids.set(key, `m${next++}`);
    }
    return ids.get(key);
  };
  return events.map((event) => ({
    actor: event.actor,
    buttons: Array.isArray(event.buttons)
      ? event.buttons.map((button) => ({ text: button?.text ?? "", type: button?.type ?? "" }))
      : [],
    contentType: typeof event.contentType === "string" ? event.contentType : "",
    isPermanent: event.kind === "delete" ? event.isPermanent === true : undefined,
    kind: event.kind,
    message: idFor(event.messageId),
    replyTo: idFor(event.replyToMessageId),
    text: typeof event.text === "string" ? event.text : "",
  }));
}

function normalizeInvocationArg(key, value) {
  if (["repoRoot", "config"].includes(key)) {
    return `<${key}>`;
  }
  if (/messageId$/iu.test(key) || ["replyTo", "focusMessageId"].includes(key)) {
    return value ? "<message-id>" : value;
  }
  if (["since", "readyAfterMs", "status"].includes(key)) {
    return undefined;
  }
  if (key.endsWith("File") && typeof value === "string") {
    return path.basename(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stableValue(entry));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([nestedKey, nestedValue]) => [nestedKey, normalizeInvocationArg(nestedKey, nestedValue)])
        .filter(([, nestedValue]) => nestedValue !== undefined),
    );
  }
  return value;
}

export function normalizeInvocations(invocations) {
  if (!Array.isArray(invocations)) {
    return [];
  }
  return invocations.map((invocation) => ({
    args: isRecord(invocation?.args)
      ? Object.fromEntries(
          Object.entries(invocation.args)
            .map(([key, value]) => [key, normalizeInvocationArg(key, value)])
            .filter(([, value]) => value !== undefined),
        )
      : {},
    command: invocation?.command ?? "",
  }));
}

function compactText(value, maximum = 80) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

export function summarizeVisibleEvents(events) {
  const rows = events.slice(-8).map((event) => {
    const text = compactText(event.text);
    return `${event.actor} ${event.kind}${text ? ` “${text}”` : ""}`;
  });
  return `${events.length} visible event${events.length === 1 ? "" : "s"}${
    rows.length ? `: ${rows.join(" → ")}` : ""
  }`;
}

function gapKey(assertion) {
  return assertion.type === "gap" ? stableStringify({ from: assertion.from, to: assertion.to }) : null;
}

function gapContract(assertion) {
  return {
    max: assertion.maxMs ?? Number.POSITIVE_INFINITY,
    min: assertion.minMs ?? 0,
  };
}

function disjointGapContracts(left, right) {
  const a = gapContract(left);
  const b = gapContract(right);
  return a.max + 500 < b.min || b.max + 500 < a.min;
}

export function materialTimingDifference(assertions, baselineResults, candidateResults) {
  const baseline = new Map();
  assertions.baseline.expect.forEach((assertion, index) => {
    const key = gapKey(assertion);
    if (key) {
      baseline.set(key, { assertion, result: baselineResults[index] });
    }
  });
  for (let index = 0; index < assertions.candidate.expect.length; index += 1) {
    const assertion = assertions.candidate.expect[index];
    const key = gapKey(assertion);
    const left = key ? baseline.get(key) : undefined;
    const rightResult = candidateResults[index];
    if (
      !left ||
      !disjointGapContracts(left.assertion, assertion) ||
      left.result.gapMs === undefined ||
      rightResult.gapMs === undefined
    ) {
      continue;
    }
    const deltaMs = Math.abs(left.result.gapMs - rightResult.gapMs);
    if (deltaMs >= MATERIAL_TIMING_DELTA_MS) {
      return { deltaMs, key };
    }
  }
  return null;
}
