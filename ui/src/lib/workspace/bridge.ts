// Parent side of the custom-widget postMessage bridge (00 §6, spec-50 §Bridge).
//
// DOM-free and unit-testable: the browser host (`workspace-custom-widget.ts`)
// wires a real iframe + window listener to `createWidgetBridge`, but every
// security decision — accept filter, manifest gating, capability checks, rate
// limiting, timeouts — lives here so it can be tested without a DOM.
//
// SECURITY MODEL (normative):
// - The child's origin is opaque (`null`) because the iframe is sandboxed without
//   `allow-same-origin`. The host accepts one token-bound bootstrap from the
//   iframe, then all traffic uses that document's MessagePort. Navigation loses
//   the port, unlike the iframe's stable WindowProxy.
// - A widget may only request bindings declared in the manifest the operator
//   approved. Undeclared bindingId → `workspace:error {code:"binding_denied"}`.
// - `sendPrompt` requires the manifest `prompt:send` capability AND an operator
//   confirm per invocation AND a rate limit (1 in-flight, 10/min).
// - Parent→child posts always use targetOrigin "*" (opaque origin), carrying only
//   binding data / theme tokens the widget is entitled to — never secrets.

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { WidgetManifestView } from "./types.ts";

const BRIDGE_ENVELOPE_VERSION = 1;

/** child→parent message types. */
type WidgetInboundType =
  | "workspace:ready"
  | "workspace:getData"
  | "workspace:getTheme"
  | "workspace:sendPrompt";

type WidgetErrorCode =
  | "binding_denied"
  | "capability_denied"
  | "rate_limited"
  | "prompt_declined"
  | "timeout"
  | "resolve_failed"
  | "malformed";

export type WidgetOutboundMessage =
  | { v: 1; type: "workspace:data"; requestId: string; bindingId: string; data: unknown }
  | { v: 1; type: "workspace:push"; bindingId: string; data: unknown }
  | { v: 1; type: "workspace:theme"; requestId: string; tokens: Record<string, string> }
  | { v: 1; type: "workspace:error"; requestId?: string; code: WidgetErrorCode; message: string };

/** Injected side effects — real implementations live in the browser host. */
type WidgetBridgeDeps = {
  manifest: WidgetManifestView;
  /** Resolve a manifest-declared binding by id. */
  resolveBinding: (bindingId: string) => Promise<unknown>;
  /**
   * Resolve-time gate run BEFORE `resolveBinding`. Return a WidgetErrorCode to
   * deny without resolving the binding, or null to allow. Optional; when omitted,
   * every declared binding is allowed to resolve.
   */
  assertBindingAllowed?: (bindingId: string) => WidgetErrorCode | null;
  /** Current theme tokens (CSS custom-property values from the document root). */
  resolveTheme: () => Record<string, string>;
  /** Operator confirm dialog quoting the exact prompt text; resolves true to send. */
  confirmPrompt: (text: string) => Promise<boolean>;
  /** Dispatch the prompt through the existing chat-send path. */
  sendPrompt: (text: string) => Promise<void>;
  /** Post a message to the child (host wires targetOrigin "*"). */
  post: (message: WidgetOutboundMessage) => void;
  /** getData answer deadline; posts a timeout error if the resolver overruns. Default 10s. */
  getDataTimeoutMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
};

export type WidgetBridge = {
  /** Handle one already-source-verified inbound message. Returns true if accepted. */
  handleMessage: (data: unknown) => boolean;
  /** Push fresh data for a declared binding to the child (broadcast-driven). */
  push: (bindingId: string) => Promise<void>;
  /** Count of messages dropped by the accept filter (well-formedness). For tests. */
  readonly droppedCount: number;
  dispose: () => void;
};

const DEFAULT_GET_DATA_TIMEOUT_MS = 10_000;
const PROMPT_RATE_WINDOW_MS = 60_000;
const PROMPT_RATE_MAX = 10;

/**
 * sendPrompt rate-limit state, keyed by STABLE widget identity (the custom widget
 * name), NOT the iframe/bridge instance. The lit host recreates the iframe (and a
 * fresh bridge) on layout drag / tab switch / widget re-add, so per-closure state
 * would let a widget reset its "10/min + 1 in-flight" cap simply by triggering a
 * remount. Persisting this at module scope keyed by name closes that hole: the
 * rolling window survives bridge re-instantiation. Each distinct widget name has
 * its own independent budget.
 */
type PromptRateState = { timestamps: number[]; inFlight: boolean };
const promptRateStates = new Map<string, PromptRateState>();

function getPromptRateState(widgetName: string): PromptRateState {
  let state = promptRateStates.get(widgetName);
  if (!state) {
    state = { timestamps: [], inFlight: false };
    promptRateStates.set(widgetName, state);
  }
  return state;
}

/** Test-only: reset all persisted rate-limit budgets. */

const INBOUND_TYPES = new Set<WidgetInboundType>([
  "workspace:ready",
  "workspace:getData",
  "workspace:getTheme",
  "workspace:sendPrompt",
]);

/**
 * Well-formedness filter: a valid inbound message is an object with `v === 1` and
 * a known `type`. Anything else is dropped silently (counted for tests). This runs
 * after the host has moved traffic onto the approved document's MessagePort.
 */
function isWellFormedInbound(
  data: unknown,
): data is { v: 1; type: WidgetInboundType } & Record<string, unknown> {
  return (
    isRecord(data) &&
    data.v === BRIDGE_ENVELOPE_VERSION &&
    typeof data.type === "string" &&
    INBOUND_TYPES.has(data.type as WidgetInboundType)
  );
}

/** Creates the parent-side bridge for one approved custom widget. */
export function createWidgetBridge(deps: WidgetBridgeDeps): WidgetBridge {
  const now = deps.now ?? (() => Date.now());
  const getDataTimeoutMs = deps.getDataTimeoutMs ?? DEFAULT_GET_DATA_TIMEOUT_MS;
  const declaredBindingIds = new Set(Object.keys(deps.manifest.bindings));
  const capabilities = new Set(deps.manifest.capabilities);
  let dropped = 0;
  let disposed = false;
  // Rate-limit state is keyed by the widget NAME (stable identity), so it persists
  // across bridge re-instantiation when the iframe is recreated.
  const rateState = getPromptRateState(deps.manifest.name);
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  function error(code: WidgetErrorCode, message: string, requestId?: string): void {
    deps.post({
      v: 1,
      type: "workspace:error",
      ...(requestId !== undefined ? { requestId } : {}),
      code,
      message,
    });
  }

  async function handleGetData(requestId: string, bindingId: string): Promise<void> {
    if (!capabilities.has("data:read")) {
      error("capability_denied", "widget lacks the data:read capability", requestId);
      return;
    }
    if (!declaredBindingIds.has(bindingId)) {
      // A widget cannot request a binding the operator did not approve.
      error("binding_denied", `binding not declared in manifest: ${bindingId}`, requestId);
      return;
    }
    // Resolve-time gate: host-specific grant mismatches are denied before any
    // resolver or gateway access.
    const denied = deps.assertBindingAllowed?.(bindingId);
    if (denied) {
      error(denied, `binding not allowed: ${bindingId}`, requestId);
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled || disposed) {
        return;
      }
      settled = true;
      pendingTimers.delete(timer);
      error("timeout", "binding resolution timed out", requestId);
    }, getDataTimeoutMs);
    pendingTimers.add(timer);
    try {
      const data = await deps.resolveBinding(bindingId);
      if (settled || disposed) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      pendingTimers.delete(timer);
      deps.post({ v: 1, type: "workspace:data", requestId, bindingId, data });
    } catch (err) {
      if (settled || disposed) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      pendingTimers.delete(timer);
      error("resolve_failed", err instanceof Error ? err.message : String(err), requestId);
    }
  }

  function handleGetTheme(requestId: string): void {
    deps.post({ v: 1, type: "workspace:theme", requestId, tokens: deps.resolveTheme() });
  }

  async function handleSendPrompt(requestId: string, text: string): Promise<void> {
    if (!capabilities.has("prompt:send")) {
      // Denied WITHOUT showing a dialog — the capability gate is first.
      error("capability_denied", "widget lacks the prompt:send capability", requestId);
      return;
    }
    // Rate limit: at most one in-flight prompt and 10 per rolling minute, keyed by
    // widget name so a remount cannot reset the budget.
    const cutoff = now() - PROMPT_RATE_WINDOW_MS;
    rateState.timestamps = rateState.timestamps.filter((ts) => ts > cutoff);
    if (rateState.inFlight || rateState.timestamps.length >= PROMPT_RATE_MAX) {
      error("rate_limited", "prompt send rate limit exceeded", requestId);
      return;
    }
    rateState.inFlight = true;
    try {
      const confirmed = await deps.confirmPrompt(text);
      if (disposed) {
        return;
      }
      if (!confirmed) {
        // Deny path sends NOTHING.
        error("prompt_declined", "operator declined the prompt", requestId);
        return;
      }
      rateState.timestamps.push(now());
      await deps.sendPrompt(text);
    } catch (err) {
      if (!disposed) {
        error("resolve_failed", err instanceof Error ? err.message : String(err), requestId);
      }
    } finally {
      rateState.inFlight = false;
    }
  }

  function handleMessage(data: unknown): boolean {
    if (disposed) {
      return false;
    }
    if (!isWellFormedInbound(data)) {
      dropped += 1;
      return false;
    }
    switch (data.type) {
      case "workspace:ready":
        return true;
      case "workspace:getData": {
        const requestId = typeof data.requestId === "string" ? data.requestId : null;
        const bindingId = typeof data.bindingId === "string" ? data.bindingId : null;
        if (requestId === null || bindingId === null) {
          dropped += 1;
          return false;
        }
        void handleGetData(requestId, bindingId);
        return true;
      }
      case "workspace:getTheme": {
        const requestId = typeof data.requestId === "string" ? data.requestId : null;
        if (requestId === null) {
          dropped += 1;
          return false;
        }
        handleGetTheme(requestId);
        return true;
      }
      case "workspace:sendPrompt": {
        const requestId = typeof data.requestId === "string" ? data.requestId : null;
        const text = typeof data.text === "string" ? data.text : null;
        if (requestId === null || text === null || !text.trim()) {
          dropped += 1;
          return false;
        }
        void handleSendPrompt(requestId, text);
        return true;
      }
      default:
        dropped += 1;
        return false;
    }
  }

  async function push(bindingId: string): Promise<void> {
    if (
      disposed ||
      !capabilities.has("data:read") ||
      !declaredBindingIds.has(bindingId) ||
      deps.assertBindingAllowed?.(bindingId)
    ) {
      // A disallowed binding is never pushed (same gate as getData; silent for push).
      return;
    }
    try {
      const data = await deps.resolveBinding(bindingId);
      if (!disposed) {
        deps.post({ v: 1, type: "workspace:push", bindingId, data });
      }
    } catch {
      // Push is best-effort; a failed refresh keeps the last value on the child.
    }
  }

  return {
    handleMessage,
    push,
    get droppedCount() {
      return dropped;
    },
    dispose() {
      disposed = true;
      for (const timer of pendingTimers) {
        clearTimeout(timer);
      }
      pendingTimers.clear();
      // Release the in-flight lock so a remount can send again, but PRESERVE the
      // rolling-window timestamps — clearing them would reopen the very reset hole
      // this state exists to close.
      rateState.inFlight = false;
    },
  };
}
