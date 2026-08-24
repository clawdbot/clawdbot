import { randomUUID } from "node:crypto";
import {
  MAX_TIMER_TIMEOUT_MS,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { retainBeforeToolCallForNativeHookRelay } from "./host-capability.js";
import {
  NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS,
  registerNativeHookRelayBridge,
  renewNativeHookRelayBridgeRecord,
  unregisterNativeHookRelayBridge,
} from "./native-hook-relay-bridge.js";
import {
  buildNativeHookRelayCommandWithStateDatabase,
  resolveNativeHookRelayCommandTimeoutMs,
} from "./native-hook-relay-command.js";
import {
  nativeHookRelayEventHasLocalWork,
  nativeHookRelayEventToolMatcher,
} from "./native-hook-relay-events.js";
import {
  inheritNativeHookRelayApprovalOwner,
  pruneNativeHookRelayPermissionAllowAlways,
  registerNativeHookRelayApprovalOwner,
  removeNativeHookRelayPendingApprovalsForOwner,
  removeNativeHookRelayPermissionState,
  removeNativeHookRelayPreToolUseApprovals,
} from "./native-hook-relay-permissions.js";
import { nativeHookRelayState } from "./native-hook-relay-state.js";
import type {
  ActiveNativeHookRelayRegistration,
  ActiveNativeHookRelayRegistrationHandle,
  InvokeNativeHookRelayParams,
  NativeHookRelayEvent,
  NativeHookRelayProcessResponse,
  NativeHookRelayRegistration,
  RegisterNativeHookRelayParams,
} from "./native-hook-relay-types.js";
import { NATIVE_HOOK_RELAY_EVENTS } from "./native-hook-relay-types.js";
import { normalizePositiveInteger } from "./native-hook-relay-utils.js";

type NativeHookRelayInvoker = (
  params: InvokeNativeHookRelayParams,
) => Promise<NativeHookRelayProcessResponse>;
const DEFAULT_RELAY_TTL_MS = 30 * 60 * 1000;
const log = createSubsystemLogger("agents/harness/native-hook-relay");

const { relays, relayBridges, invocations } = nativeHookRelayState;
type RelayBinding = {
  registration: ActiveNativeHookRelayRegistration;
  token: symbol;
  foregroundOpen: boolean;
  foregroundSubject?: string;
  childSubjects: Set<string>;
  retained?: ReturnType<typeof retainBeforeToolCallForNativeHookRelay>;
  retention?: NativeHookRelayRetention;
  removeAbortListener?: () => void;
};

type RelayLifetime = {
  bindings: Set<RelayBinding>;
  childBindings: Map<string, RelayBinding>;
  foreground?: RelayBinding;
  expiryTimer?: ReturnType<typeof setTimeout>;
};

const RELAY_LIFETIMES = Symbol.for("openclaw.nativeHookRelay.lifetimes");
// SAFETY: this module alone writes this symbol slot with the declared lifetime-map type.
const nativeHookRelayGlobals = globalThis as typeof globalThis & {
  [RELAY_LIFETIMES]?: WeakMap<ActiveNativeHookRelayRegistration, RelayLifetime>;
};
const relayLifetimes = (nativeHookRelayGlobals[RELAY_LIFETIMES] ??= new WeakMap());

/** Private bundled-runtime callbacks for retained direct-child hook policy. */
export type NativeHookRelayRetention = Readonly<{
  readClaim: (rawPayload: unknown) => string | undefined;
  readForegroundSubject?: (rawPayload: unknown) => string | undefined;
  shouldRetainAfterForegroundClose: () => boolean;
  allowPreToolUse: (claim: string) => boolean;
  awaitForegroundAdmission?: (claim: string) => Promise<(() => boolean) | undefined>;
  onDispose: () => void;
}>;

type RetainedNativeHookRelayParams = RegisterNativeHookRelayParams & {
  composeWithExistingRoute?: boolean;
  retention: NativeHookRelayRetention;
};

type RetainedNativeHookRelayHandle = ActiveNativeHookRelayRegistrationHandle & {
  activateForegroundBinding: () => void;
  bindForegroundSubject: (subject: string) => void;
  bindRetainedSubject: (subject: string) => () => void;
  renewRetainedSubject: (subject: string, ttlMs?: number) => void;
};

function readRelayLifetime(
  registration: ActiveNativeHookRelayRegistration,
): RelayLifetime | undefined {
  return relayLifetimes.get(registration);
}

function setRelayLifetime(
  registration: ActiveNativeHookRelayRegistration,
  lifetime: RelayLifetime,
): void {
  relayLifetimes.set(registration, lifetime);
}

function scheduleNativeHookRelayExpiry(
  relayId: string,
  route: ActiveNativeHookRelayRegistration,
): void {
  const lifetime = readRelayLifetime(route);
  if (!lifetime) {
    return;
  }
  if (lifetime.expiryTimer) {
    clearTimeout(lifetime.expiryTimer);
  }
  const rearm = () => {
    if (relays.get(relayId) !== route) {
      return;
    }
    lifetime.expiryTimer = undefined;
    const now = Date.now();
    for (const binding of lifetime.bindings) {
      if (now > binding.registration.expiresAtMs) {
        removeNativeHookRelayBinding(relayId, route, binding);
      }
    }
    if (relays.get(relayId) !== route) {
      return;
    }
    if (lifetime.expiryTimer) {
      return;
    }
    const earliestExpiry = Math.min(
      ...[...lifetime.bindings].map((binding) => binding.registration.expiresAtMs),
    );
    const remainingMs = earliestExpiry - now;
    if (remainingMs < 0) {
      rearm();
      return;
    }
    lifetime.expiryTimer = setTimeout(rearm, Math.min(remainingMs + 1, MAX_TIMER_TIMEOUT_MS));
    lifetime.expiryTimer.unref();
  };
  rearm();
}

function updateNativeHookRelayRouteExpiry(
  relayId: string,
  route: ActiveNativeHookRelayRegistration,
): boolean {
  const lifetime = readRelayLifetime(route);
  if (!lifetime || lifetime.bindings.size === 0) {
    return false;
  }
  const expiresAtMs = Math.max(
    ...[...lifetime.bindings].map((binding) => binding.registration.expiresAtMs),
  );
  const bridge = relayBridges.get(relayId);
  if (bridge?.server.listening) {
    try {
      const renewal = renewNativeHookRelayBridgeRecord(route, bridge, expiresAtMs);
      if (renewal === "unavailable") {
        return false;
      }
      if (renewal === "ownership-changed") {
        log.debug("native hook relay bridge record ownership changed", { relayId });
        unregisterNativeHookRelay(relayId, route);
        return false;
      }
    } catch (error) {
      log.debug("failed to renew native hook relay bridge record", { error, relayId });
      return false;
    }
  }
  route.expiresAtMs = expiresAtMs;
  scheduleNativeHookRelayExpiry(relayId, route);
  return true;
}

function resolveNativeHookRelayExpiresAtMs(ttlMs: number | undefined): number | undefined {
  return resolveExpiresAtMsFromDurationMs(normalizePositiveInteger(ttlMs, DEFAULT_RELAY_TTL_MS));
}

export function registerNativeHookRelayLifecycle(
  params: RegisterNativeHookRelayParams,
  invokeRelay: NativeHookRelayInvoker,
): ActiveNativeHookRelayRegistrationHandle {
  return registerNativeHookRelayInternal(params, undefined, false, invokeRelay);
}

/** Private-local bundled runtime entrypoint; not exported through the public SDK. */
export function registerRetainedNativeHookRelayLifecycle(
  params: RetainedNativeHookRelayParams,
  invokeRelay: NativeHookRelayInvoker,
): RetainedNativeHookRelayHandle {
  const { composeWithExistingRoute = false, retention, ...registrationParams } = params;
  return registerNativeHookRelayInternal(
    registrationParams,
    retention,
    composeWithExistingRoute,
    invokeRelay,
  );
}

function registerNativeHookRelayInternal(
  params: RegisterNativeHookRelayParams,
  retention: NativeHookRelayRetention | undefined,
  composeWithExistingRoute: boolean,
  invokeRelay: NativeHookRelayInvoker,
): RetainedNativeHookRelayHandle {
  pruneExpiredNativeHookRelays();
  pruneNativeHookRelayPermissionAllowAlways();
  const relayId = normalizeRelayKey(params.relayId, "id") ?? randomUUID();
  const requestedGeneration = normalizeRelayKey(params.generation, "generation");
  const existingRoute = composeWithExistingRoute ? relays.get(relayId) : undefined;
  if (
    existingRoute &&
    (existingRoute.provider !== params.provider ||
      existingRoute.agentId !== params.agentId ||
      existingRoute.sessionId !== params.sessionId ||
      existingRoute.sessionKey !== params.sessionKey ||
      (requestedGeneration !== undefined && requestedGeneration !== existingRoute.generation))
  ) {
    throw new Error("native hook relay successor route identity mismatch");
  }
  const generation = existingRoute?.generation ?? requestedGeneration ?? randomUUID();
  const generationMismatchGraceMs = normalizePositiveInteger(params.generationMismatchGraceMs, 0);
  const now = Date.now();
  const expiresAtMs = resolveNativeHookRelayExpiresAtMs(params.ttlMs);
  if (expiresAtMs === undefined) {
    throw new Error("Native hook relay expiry is outside the supported Date range");
  }
  const allowedEvents = normalizeAllowedEvents(params.allowedEvents);
  const stateDbPath = resolveOpenClawStateSqlitePath();
  const deliverReplacedRegistrationUnregister = existingRoute
    ? undefined
    : unregisterNativeHookRelay(relayId, undefined, {
        deferBridgeRecordRemovalMs: NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS,
        deferOnUnregister: true,
      });
  let preparedRoute: ActiveNativeHookRelayRegistration | undefined;
  let preparedBinding: RelayBinding | undefined;
  try {
    const registration: ActiveNativeHookRelayRegistration = {
      relayId,
      provider: params.provider,
      generation,
      ...(generationMismatchGraceMs > 0
        ? { generationMismatchGraceExpiresAtMs: now + generationMismatchGraceMs }
        : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      sessionId: params.sessionId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.config ? { config: params.config } : {}),
      runId: params.runId,
      ...(params.channelId ? { channelId: params.channelId } : {}),
      ...(params.requester ? { requester: params.requester } : {}),
      ...(params.approvalContext ? { approvalContext: params.approvalContext } : {}),
      allowedEvents,
      preToolUseLoopDetection: params.preToolUseLoopDetection !== false,
      expiresAtMs,
      preToolUseFailureProjections: new Map(),
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.runBeforeToolCall ? { runBeforeToolCall: params.runBeforeToolCall } : {}),
      ...(params.assertActive ? { assertActive: params.assertActive } : {}),
      ...(params.onPreToolUseFailure ? { onPreToolUseFailure: params.onPreToolUseFailure } : {}),
    };
    const binding: RelayBinding = {
      registration,
      token: Symbol("native-hook-relay-binding"),
      foregroundOpen: false,
      childSubjects: new Set(),
      ...(retention ? { retention } : {}),
    };
    registerNativeHookRelayApprovalOwner(registration, binding.token);
    const route = existingRoute ?? registration;
    preparedRoute = route;
    preparedBinding = binding;
    const lifetime = existingRoute
      ? readRelayLifetime(existingRoute)
      : {
          bindings: new Set<RelayBinding>(),
          childBindings: new Map<string, RelayBinding>(),
        };
    if (!lifetime) {
      throw new Error("native hook relay successor route is inactive");
    }
    lifetime.bindings.add(binding);
    if (!existingRoute) {
      relays.set(relayId, route);
      setRelayLifetime(route, lifetime);
    }
    if (params.signal) {
      const abort = () => removeNativeHookRelayBinding(relayId, route, binding);
      params.signal.addEventListener("abort", abort, { once: true });
      binding.removeAbortListener = () => params.signal?.removeEventListener("abort", abort);
      if (params.signal.aborted) {
        removeNativeHookRelayBinding(relayId, route, binding);
        throw new Error("native hook relay registration aborted");
      }
    }
    if (!existingRoute) {
      registerNativeHookRelayBridge(route, stateDbPath, invokeRelay);
    }
    const activateForegroundBinding = () => {
      if (relays.get(relayId) !== route || !lifetime.bindings.has(binding)) {
        throw new Error("native hook relay binding is inactive");
      }
      // Renew before changing foreground ownership so a transient store failure
      // leaves the last working binding authoritative.
      if (!updateNativeHookRelayRouteExpiry(relayId, route)) {
        throw new Error("native hook relay route renewal failed");
      }
      for (const previous of lifetime.bindings) {
        if (previous === binding) {
          continue;
        }
        previous.foregroundOpen = false;
        if (!shouldRetainNativeHookRelayBinding(previous)) {
          removeNativeHookRelayBinding(relayId, route, previous);
        }
      }
      if (relays.get(relayId) !== route || !lifetime.bindings.has(binding)) {
        throw new Error("native hook relay binding is inactive");
      }
      if (!binding.retained && params.runBeforeToolCall && retention) {
        binding.retained = retainBeforeToolCallForNativeHookRelay(params.runBeforeToolCall);
      }
      binding.foregroundOpen = true;
      lifetime.foreground = binding;
    };
    const handle: RetainedNativeHookRelayHandle = {
      ...registration,
      shouldRelayEvent: (event) => nativeHookRelayEventHasLocalWork(registration, event),
      toolMatcherForEvent: (event) => nativeHookRelayEventToolMatcher(registration, event),
      commandForEvent: (event, options) =>
        buildNativeHookRelayCommandWithStateDatabase({
          provider: params.provider,
          relayId,
          stateDbPath,
          generation: registration.generation,
          event,
          nice: params.command?.nice,
          timeoutMs: resolveNativeHookRelayCommandTimeoutMs(
            params.command?.timeoutMs,
            options?.timeoutMs,
          ),
          executable: params.command?.executable,
          nodeExecutable: params.command?.nodeExecutable,
        }),
      renew: (ttlMs) => {
        if (relays.get(relayId) !== route || !lifetime.bindings.has(binding)) {
          return;
        }
        const renewedExpiresAtMs = resolveNativeHookRelayExpiresAtMs(ttlMs);
        if (renewedExpiresAtMs === undefined) {
          return;
        }
        const previousExpiresAtMs = registration.expiresAtMs;
        registration.expiresAtMs = renewedExpiresAtMs;
        handle.expiresAtMs = renewedExpiresAtMs;
        if (!updateNativeHookRelayRouteExpiry(relayId, route)) {
          registration.expiresAtMs = previousExpiresAtMs;
          handle.expiresAtMs = previousExpiresAtMs;
        }
      },
      unregister: () => deactivateNativeHookRelayForeground(relayId, route, binding),
      activateForegroundBinding,
      bindForegroundSubject: (subjectInput) => {
        const subject = subjectInput.trim();
        if (!subject || relays.get(relayId) !== route || !lifetime.bindings.has(binding)) {
          throw new Error("native hook relay foreground subject is invalid");
        }
        if (binding.foregroundSubject && binding.foregroundSubject !== subject) {
          throw new Error("native hook relay foreground subject already bound");
        }
        binding.foregroundSubject = subject;
      },
      bindRetainedSubject: (subjectInput) => {
        const subject = subjectInput.trim();
        if (!subject || relays.get(relayId) !== route || !lifetime.bindings.has(binding)) {
          throw new Error("native hook relay retained subject is invalid");
        }
        const owner = lifetime.childBindings.get(subject);
        if (owner && owner !== binding) {
          throw new Error("native hook relay retained subject already claimed");
        }
        lifetime.childBindings.set(subject, binding);
        binding.childSubjects.add(subject);
        let released = false;
        return () => {
          if (released) {
            return;
          }
          released = true;
          if (lifetime.childBindings.get(subject) === binding) {
            lifetime.childBindings.delete(subject);
          }
          binding.childSubjects.delete(subject);
          if (!binding.foregroundOpen && binding.childSubjects.size === 0) {
            removeNativeHookRelayBinding(relayId, route, binding);
          }
        };
      },
      renewRetainedSubject: (subjectInput, ttlMs) => {
        const subject = subjectInput.trim();
        if (subject && lifetime.childBindings.get(subject) === binding) {
          handle.renew(ttlMs);
        }
      },
    };
    if (!composeWithExistingRoute) {
      activateForegroundBinding();
    } else if (!updateNativeHookRelayRouteExpiry(relayId, route)) {
      throw new Error("native hook relay route renewal failed");
    }
    return handle;
  } catch (error) {
    if (preparedRoute && preparedBinding) {
      removeNativeHookRelayBinding(relayId, preparedRoute, preparedBinding);
    }
    throw error;
  } finally {
    // The successor is authoritative before the old callback runs. A reentrant
    // callback can therefore replace this registration normally instead of
    // being overwritten by the outer replacement path. Finally also preserves
    // the old callback if successor setup aborts partway through.
    deliverReplacedRegistrationUnregister?.();
  }
}

export function unregisterNativeHookRelay(
  relayId: string,
  expectedRegistration?: ActiveNativeHookRelayRegistration,
  options?: { deferBridgeRecordRemovalMs?: number; deferOnUnregister?: boolean },
): (() => void) | undefined {
  if (expectedRegistration && relays.get(relayId) !== expectedRegistration) {
    return undefined;
  }
  const route = expectedRegistration ?? relays.get(relayId);
  if (!route) {
    return undefined;
  }
  const lifetime = readRelayLifetime(route);
  const bridge = relayBridges.get(relayId);
  // Detach first: owner cleanup may register a same-id successor, which must
  // never be removed by this registration's later resource cleanup.
  if (relays.get(relayId) === route) {
    relays.delete(relayId);
  }
  if (lifetime?.expiryTimer) {
    clearTimeout(lifetime.expiryTimer);
  }
  const bindings = lifetime ? [...lifetime.bindings] : [];
  lifetime?.bindings.clear();
  lifetime?.childBindings.clear();
  if (lifetime) {
    lifetime.foreground = undefined;
  }
  for (const binding of bindings) {
    binding.removeAbortListener?.();
    binding.retained?.release();
  }
  relayLifetimes.delete(route);
  unregisterNativeHookRelayBridge(relayId, {
    ...options,
    ...(bridge ? { expectedBridge: bridge } : {}),
  });
  removeNativeHookRelayInvocations(relayId);
  removeNativeHookRelayPreToolUseApprovals(relayId);
  removeNativeHookRelayPermissionState(relayId);
  const deliverOnUnregister = () => {
    for (const binding of bindings) {
      deliverNativeHookRelayBindingDispose(relayId, binding);
    }
  };
  if (options?.deferOnUnregister) {
    return deliverOnUnregister;
  }
  deliverOnUnregister();
  return undefined;
}

function deliverNativeHookRelayBindingDispose(relayId: string, binding: RelayBinding): void {
  try {
    binding.retention?.onDispose();
  } catch (error) {
    try {
      log.warn("native hook relay unregister callback failed", { error, relayId });
    } catch {
      // Teardown has already detached every identity-bound resource. Logging
      // must not turn an observer callback failure into a cleanup failure.
    }
  }
}

function removeNativeHookRelayBinding(
  relayId: string,
  route: ActiveNativeHookRelayRegistration,
  binding: RelayBinding,
): void {
  const lifetime = readRelayLifetime(route);
  if (relays.get(relayId) !== route || !lifetime?.bindings.delete(binding)) {
    return;
  }
  if (lifetime.foreground === binding) {
    lifetime.foreground = undefined;
  }
  binding.foregroundOpen = false;
  for (const subject of binding.childSubjects) {
    if (lifetime.childBindings.get(subject) === binding) {
      lifetime.childBindings.delete(subject);
    }
  }
  binding.childSubjects.clear();
  binding.removeAbortListener?.();
  binding.retained?.release();
  removeNativeHookRelayPendingApprovalsForOwner(relayId, binding.registration);
  deliverNativeHookRelayBindingDispose(relayId, binding);
  if (lifetime.bindings.size === 0) {
    unregisterNativeHookRelay(relayId, route);
    return;
  }
  updateNativeHookRelayRouteExpiry(relayId, route);
}

function shouldRetainNativeHookRelayBinding(binding: RelayBinding): boolean {
  if (!binding.retained || !binding.retention || binding.childSubjects.size === 0) {
    return false;
  }
  try {
    return binding.retention.shouldRetainAfterForegroundClose();
  } catch (error) {
    try {
      log.warn("native hook relay retention predicate failed", {
        error,
        relayId: binding.registration.relayId,
      });
    } catch {
      // A logging failure cannot make a throwing retention predicate retain authority.
    }
    return false;
  }
}

function deactivateNativeHookRelayForeground(
  relayId: string,
  route: ActiveNativeHookRelayRegistration,
  binding: RelayBinding,
): void {
  if (relays.get(relayId) !== route) {
    return;
  }
  const lifetime = readRelayLifetime(route);
  if (!lifetime?.bindings.has(binding)) {
    return;
  }
  binding.foregroundOpen = false;
  if (lifetime.foreground === binding) {
    lifetime.foreground = undefined;
  }
  if (shouldRetainNativeHookRelayBinding(binding)) {
    return;
  }
  removeNativeHookRelayBinding(relayId, route, binding);
}

export async function resolveNativeHookRelayInvocationBinding(
  route: ActiveNativeHookRelayRegistration,
  event: NativeHookRelayEvent,
  rawPayload: unknown,
): Promise<ActiveNativeHookRelayRegistration> {
  const lifetime = readRelayLifetime(route);
  if (!lifetime) {
    throw new Error("native hook relay registration is inactive");
  }
  const subjectReader =
    lifetime.foreground?.retention ??
    [...lifetime.bindings].find((binding) => binding.retention)?.retention;
  const claim = subjectReader?.readClaim(rawPayload);
  if (claim) {
    let binding = lifetime.childBindings.get(claim);
    let assertAdmission: (() => boolean) | undefined;
    if (!binding && event === "pre_tool_use") {
      const foreground = lifetime.foreground;
      const retention = foreground?.retention;
      if (!foreground?.foregroundOpen || !retention?.awaitForegroundAdmission) {
        throw new Error("native hook relay retained invocation not allowed");
      }
      if (!foreground.registration.allowedEvents.includes(event)) {
        throw new Error("native hook relay event not allowed");
      }
      assertAdmission = await retention.awaitForegroundAdmission(claim);
      if (!assertAdmission) {
        throw new Error("native hook relay retained invocation not allowed");
      }
      binding = lifetime.childBindings.get(claim);
    }
    if (!binding) {
      throw new Error("native hook relay retained invocation not allowed");
    }
    const selected = binding;
    const retained = selected.retained;
    const retention = selected.retention;
    if (!retained || !retention) {
      throw new Error("native hook relay retained invocation not allowed");
    }
    const assertRetainedAuthority = () => {
      if (
        relays.get(route.relayId) !== route ||
        !lifetime.bindings.has(selected) ||
        Date.now() > selected.registration.expiresAtMs
      ) {
        throw new Error("native hook relay registration is inactive");
      }
      selected.registration.signal?.throwIfAborted();
      retained.assertActive();
      if (assertAdmission && !assertAdmission()) {
        throw new Error("native hook relay retained invocation not allowed");
      }
      if (lifetime.childBindings.get(claim) !== selected || !retention.allowPreToolUse(claim)) {
        throw new Error("native hook relay retained invocation not allowed");
      }
    };
    const effectiveRegistration = {
      ...selected.registration,
      assertActive: assertRetainedAuthority,
      runBeforeToolCall: retained.runBeforeToolCall,
    };
    inheritNativeHookRelayApprovalOwner(effectiveRegistration, selected.registration);
    return effectiveRegistration;
  }
  const foreground = lifetime.foreground;
  const foregroundSubject = subjectReader?.readForegroundSubject?.(rawPayload);
  if (!foreground?.foregroundOpen || foreground.foregroundSubject !== foregroundSubject) {
    throw new Error("native hook relay foreground invocation not allowed");
  }
  const foregroundToken = foreground.token;
  const assertActive = () => {
    if (
      relays.get(route.relayId) !== route ||
      !lifetime.bindings.has(foreground) ||
      Date.now() > foreground.registration.expiresAtMs
    ) {
      throw new Error("native hook relay registration is inactive");
    }
    foreground.registration.signal?.throwIfAborted();
    foreground.registration.assertActive?.();
    if (
      lifetime.foreground !== foreground ||
      !foreground.foregroundOpen ||
      foreground.token !== foregroundToken
    ) {
      throw new Error("native hook relay foreground invocation not allowed");
    }
  };
  const effectiveRegistration = { ...foreground.registration, assertActive };
  inheritNativeHookRelayApprovalOwner(effectiveRegistration, foreground.registration);
  return effectiveRegistration;
}

function normalizeRelayKey(
  value: string | undefined,
  kind: "id" | "generation",
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > 160 || !/^[A-Za-z0-9._:-]+$/u.test(trimmed)) {
    throw new Error(`native hook relay ${kind} must be non-empty, compact, and URL-safe`);
  }
  return trimmed;
}

export function getNativeHookRelayRoute(
  relayId: string,
): ActiveNativeHookRelayRegistration | undefined {
  return relays.get(relayId);
}

export function listNativeHookRelayRoutes(): Iterable<
  readonly [string, ActiveNativeHookRelayRegistration]
> {
  return relays;
}

export function getNativeHookRelayRegistrationForTests(
  relayId: string,
): NativeHookRelayRegistration | undefined {
  const route = relays.get(relayId);
  return route ? (readRelayLifetime(route)?.foreground?.registration ?? route) : undefined;
}

function removeNativeHookRelayInvocations(relayId: string): void {
  for (let index = invocations.length - 1; index >= 0; index -= 1) {
    if (invocations[index]?.relayId === relayId) {
      invocations.splice(index, 1);
    }
  }
}

export function pruneExpiredNativeHookRelays(now = Date.now()): void {
  for (const [relayId, route] of relays) {
    const lifetime = readRelayLifetime(route);
    for (const binding of lifetime?.bindings ?? []) {
      if (now > binding.registration.expiresAtMs) {
        removeNativeHookRelayBinding(relayId, route, binding);
      }
    }
  }
}

function normalizeAllowedEvents(
  events: readonly NativeHookRelayEvent[] | undefined,
): readonly NativeHookRelayEvent[] {
  if (!events?.length) {
    return NATIVE_HOOK_RELAY_EVENTS;
  }
  return [...new Set(events)];
}
