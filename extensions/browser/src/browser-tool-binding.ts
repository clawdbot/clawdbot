import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

type BrowserTabToolBinding = {
  kind: "tab";
  tabId: number;
  target: "host" | "node";
  node?: string;
  profile: string;
  targetId: string;
};

type BindingResult = { ok: true; binding: BrowserTabToolBinding } | { ok: false; error: string };

/** Validate the plugin-owned run binding before any browser route is resolved. */
export function parseBrowserTabToolBinding(value: unknown): BindingResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "browser tool binding must be an object" };
  }
  const record = value as Record<string, unknown>;
  const target = record.target === "host" || record.target === "node" ? record.target : undefined;
  const node = normalizeOptionalString(record.node);
  const profile = normalizeOptionalString(record.profile);
  const targetId = normalizeOptionalString(record.targetId);
  if (record.kind !== "tab") {
    return { ok: false, error: 'browser tool binding kind must be "tab"' };
  }
  if (!Number.isSafeInteger(record.tabId) || Number(record.tabId) < 0) {
    return { ok: false, error: "browser tool binding tabId must be a non-negative integer" };
  }
  if (!target || !profile || !targetId || (target === "node" && !node)) {
    return { ok: false, error: "browser tool binding requires target, profile, and targetId" };
  }
  if (target === "host" && node) {
    return { ok: false, error: "browser host binding cannot include node" };
  }
  return {
    ok: true,
    binding: {
      kind: "tab",
      tabId: Number(record.tabId),
      target,
      ...(node ? { node } : {}),
      profile,
      targetId,
    },
  };
}

export const BROWSER_TAB_BOUND_ACTIONS = [
  "act",
  "close",
  "console",
  "requests",
  "errors",
  "text",
  "emulate",
  "dialog",
  "download",
  "focus",
  "navigate",
  "pdf",
  "screenshot",
  "snapshot",
  "tabs",
  "upload",
  "waitfordownload",
] as const;

function bindTargetId(record: Record<string, unknown>, targetId: string): Record<string, unknown> {
  const requestedTargetId = normalizeOptionalString(record.targetId);
  if (requestedTargetId && requestedTargetId !== targetId) {
    throw new Error("browser action cannot override its run-bound tab target");
  }
  const actions = Array.isArray(record.actions)
    ? record.actions.map((action) =>
        action && typeof action === "object" && !Array.isArray(action)
          ? bindTargetId(action as Record<string, unknown>, targetId)
          : action,
      )
    : record.actions;
  return { ...record, targetId, ...(actions ? { actions } : {}) };
}

/** Pin model-supplied browser arguments to the trusted tab route for this run. */
export function applyBrowserTabToolBinding(
  input: Record<string, unknown>,
  binding: BrowserTabToolBinding,
): Record<string, unknown> {
  const requestedTarget = normalizeOptionalString(input.target);
  const requestedNode = normalizeOptionalString(input.node);
  const requestedProfile = normalizeOptionalString(input.profile);
  if (requestedTarget && requestedTarget !== binding.target) {
    throw new Error("browser action cannot override its run-bound target");
  }
  if (requestedNode && requestedNode !== binding.node) {
    throw new Error("browser action cannot override its run-bound node");
  }
  if (requestedProfile && requestedProfile !== binding.profile) {
    throw new Error("browser action cannot override its run-bound profile");
  }
  const bound = bindTargetId(input, binding.targetId);
  const request =
    bound.request && typeof bound.request === "object" && !Array.isArray(bound.request)
      ? bindTargetId(bound.request as Record<string, unknown>, binding.targetId)
      : bound.request;
  return {
    ...bound,
    target: binding.target,
    ...(binding.node ? { node: binding.node } : {}),
    profile: binding.profile,
    ...(request ? { request } : {}),
  };
}
