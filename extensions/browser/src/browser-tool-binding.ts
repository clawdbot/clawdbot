type BrowserTabToolBinding = {
  kind: "tab";
  tabId: number;
  target: "host" | "node";
  node?: string;
  profile: string;
  targetId: string;
};

type BindingResult = { ok: true; binding: BrowserTabToolBinding } | { ok: false; error: string };

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Validate the plugin-owned run binding before any browser route is resolved. */
export function parseBrowserTabToolBinding(value: unknown): BindingResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "browser tool binding must be an object" };
  }
  const record = value as Record<string, unknown>;
  const target = record.target === "host" || record.target === "node" ? record.target : undefined;
  const node = nonEmptyString(record.node);
  const profile = nonEmptyString(record.profile);
  const targetId = nonEmptyString(record.targetId);
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

const TAB_BOUND_ACTIONS = new Set([
  "act",
  "close",
  "console",
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
]);

function bindTargetId(record: Record<string, unknown>, targetId: string): Record<string, unknown> {
  const requestedTargetId = nonEmptyString(record.targetId);
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
  const action = nonEmptyString(input.action);
  if (!action || !TAB_BOUND_ACTIONS.has(action)) {
    throw new Error(`browser action ${JSON.stringify(action)} is unavailable in a tab-bound run`);
  }
  const requestedTarget = nonEmptyString(input.target);
  const requestedNode = nonEmptyString(input.node);
  const requestedProfile = nonEmptyString(input.profile);
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
