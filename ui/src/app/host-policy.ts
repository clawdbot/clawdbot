import type { RouteId } from "../app-route-paths.ts";

export type HostControlRouteState = "enabled" | "readOnly" | "disabled";
export type HostControlSettingState = "editable" | "readOnly" | "locked";
export type HostControlActionState = "enabled" | "disabled" | "brokered";

export type HostControlRoutePolicy = {
  state: HostControlRouteState;
  reason?: string;
};

export type HostControlSettingPolicy = {
  state: HostControlSettingState;
  reason?: string;
};

export type HostControlActionPolicy = {
  state: HostControlActionState;
  reason?: string;
};

export type HostControlPolicyV1 = {
  version: 1;
  host: {
    id: string;
    mode: string;
    displayName?: string;
  };
  gateway: {
    path: string;
    scopes: readonly string[];
  };
  defaults: {
    route: HostControlRouteState;
    setting: HostControlSettingState;
    action: HostControlActionState;
  };
  routes: Readonly<Record<string, HostControlRoutePolicy>>;
  /**
   * V1 supports a coarse settings lock through the "*" entry or the
   * defaults.setting value. Field-level ownership is intentionally left to a
   * later, server-enforced settings contract.
   */
  settings: Readonly<Record<string, HostControlSettingPolicy>>;
  actions: Readonly<Record<string, HostControlActionPolicy>>;
};

export type HostPolicyActionPreflightResult =
  | { ok: true }
  | {
      ok: false;
      code: "HOST_POLICY_BLOCKED";
      message: string;
      details: {
        action: string;
        state: HostControlActionState;
        reason?: string;
      };
    };

export type HostPolicyCapability = {
  readonly snapshot: HostControlPolicyV1;
  replace: (policy: unknown) => void;
  refresh: (basePath: string) => Promise<void>;
  subscribe: (listener: (policy: HostControlPolicyV1) => void) => () => void;
  routePolicy: (routeId: RouteId | string) => HostControlRoutePolicy;
  routeState: (routeId: RouteId | string) => HostControlRouteState;
  isRouteEnabled: (routeId: RouteId | string) => boolean;
  settingPolicy: (path: string | readonly string[]) => HostControlSettingPolicy;
  settingState: (path: string | readonly string[]) => HostControlSettingState;
  isSettingEditable: (path: string | readonly string[]) => boolean;
  actionPolicy: (action: string) => HostControlActionPolicy;
  actionState: (action: string) => HostControlActionState;
  canInvokeAction: (action: string) => boolean;
  preflightAction: (action: string) => HostPolicyActionPreflightResult;
};

const LOCAL_POLICY: HostControlPolicyV1 = {
  version: 1,
  host: {
    id: "openclaw",
    mode: "local",
    displayName: "OpenClaw",
  },
  gateway: {
    path: "",
    scopes: [],
  },
  defaults: {
    route: "enabled",
    setting: "editable",
    action: "enabled",
  },
  routes: {},
  settings: {},
  actions: {},
};

const ROUTE_STATES = new Set<HostControlRouteState>(["enabled", "readOnly", "disabled"]);
const SETTING_STATES = new Set<HostControlSettingState>(["editable", "readOnly", "locked"]);
const ACTION_STATES = new Set<HostControlActionState>(["enabled", "disabled", "brokered"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function normalizeReason(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeRoutePolicy(value: unknown): HostControlRoutePolicy | null {
  const candidate = isObject(value) ? value.state : value;
  if (!ROUTE_STATES.has(candidate as HostControlRouteState)) {
    return null;
  }
  return {
    state: candidate as HostControlRouteState,
    reason: isObject(value) ? normalizeReason(value.reason) : undefined,
  };
}

function normalizeSettingPolicy(value: unknown): HostControlSettingPolicy | null {
  const candidate = isObject(value) ? value.state : value;
  if (!SETTING_STATES.has(candidate as HostControlSettingState)) {
    return null;
  }
  return {
    state: candidate as HostControlSettingState,
    reason: isObject(value) ? normalizeReason(value.reason) : undefined,
  };
}

function normalizeActionPolicy(value: unknown): HostControlActionPolicy | null {
  const candidate = isObject(value) ? value.state : value;
  if (!ACTION_STATES.has(candidate as HostControlActionState)) {
    return null;
  }
  return {
    state: candidate as HostControlActionState,
    reason: isObject(value) ? normalizeReason(value.reason) : undefined,
  };
}

function normalizePolicyMap<T>(
  value: unknown,
  normalize: (value: unknown) => T | null,
): Readonly<Record<string, T>> {
  if (!isObject(value)) {
    return {};
  }
  const entries = Object.entries(value)
    .map(([key, policy]) => [key.trim(), normalize(policy)] as const)
    .filter((entry): entry is readonly [string, T] => Boolean(entry[0]) && entry[1] !== null);
  return Object.fromEntries(entries);
}

function normalizeSettingsPolicyMap(
  value: unknown,
): Readonly<Record<string, HostControlSettingPolicy>> {
  const wildcard = isObject(value) ? normalizeSettingPolicy(value["*"]) : null;
  return wildcard ? { "*": wildcard } : {};
}

function normalizeHostControlPolicy(value: unknown): HostControlPolicyV1 {
  const root = isObject(value) ? value : {};
  const policyRoot =
    isObject(root.hostControlPolicy) || isObject(root.controlPolicy) || isObject(root.policy)
      ? ((root.hostControlPolicy ?? root.controlPolicy ?? root.policy) as Record<string, unknown>)
      : root;
  const host = isObject(policyRoot.host) ? policyRoot.host : {};
  const gateway = isObject(policyRoot.gateway) ? policyRoot.gateway : {};
  const defaults = isObject(policyRoot.defaults) ? policyRoot.defaults : {};
  const routeDefault = ROUTE_STATES.has(defaults.route as HostControlRouteState)
    ? (defaults.route as HostControlRouteState)
    : LOCAL_POLICY.defaults.route;
  const settingDefault = SETTING_STATES.has(defaults.setting as HostControlSettingState)
    ? (defaults.setting as HostControlSettingState)
    : LOCAL_POLICY.defaults.setting;
  const actionDefault = ACTION_STATES.has(defaults.action as HostControlActionState)
    ? (defaults.action as HostControlActionState)
    : LOCAL_POLICY.defaults.action;

  return {
    version: 1,
    host: {
      id: readString(host.id, LOCAL_POLICY.host.id),
      mode: readString(host.mode, LOCAL_POLICY.host.mode),
      displayName: readString(host.displayName, LOCAL_POLICY.host.displayName ?? ""),
    },
    gateway: {
      path: readString(gateway.path, LOCAL_POLICY.gateway.path),
      scopes: readStringArray(gateway.scopes),
    },
    defaults: {
      route: routeDefault,
      setting: settingDefault,
      action: actionDefault,
    },
    routes: normalizePolicyMap(policyRoot.routes, normalizeRoutePolicy),
    settings: normalizeSettingsPolicyMap(policyRoot.settings),
    actions: normalizePolicyMap(policyRoot.actions, normalizeActionPolicy),
  };
}

function policyPath(path: string | readonly string[]): string {
  const raw = typeof path === "string" ? path : path.join(".");
  return raw
    .split(".")
    .map((part: string) => part.trim())
    .filter(Boolean)
    .join(".");
}

function lookupHierarchicalPolicy<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  const normalized = policyPath(key);
  if (!normalized) {
    return undefined;
  }
  const exact = map[normalized];
  if (exact) {
    return exact;
  }
  const parts = normalized.split(".");
  for (let index = parts.length; index > 0; index -= 1) {
    const wildcard = `${parts.slice(0, index).join(".")}.*`;
    const match = map[wildcard];
    if (match) {
      return match;
    }
  }
  return map["*"];
}

async function loadPolicyFromConfig(basePath: string): Promise<unknown | null> {
  if (typeof fetch !== "function") {
    return null;
  }
  const path = `${basePath.replace(/\/$/, "")}/control-ui-config.json`;
  try {
    const response = await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
}

export function createHostPolicyCapability(initialPolicy?: unknown): HostPolicyCapability {
  let snapshot =
    initialPolicy === undefined ? LOCAL_POLICY : normalizeHostControlPolicy(initialPolicy);
  const listeners = new Set<(policy: HostControlPolicyV1) => void>();

  const publish = () => {
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const routePolicy = (routeId: RouteId | string): HostControlRoutePolicy =>
    snapshot.routes[routeId] ?? { state: snapshot.defaults.route };
  const settingPolicy = (_path: string | readonly string[]): HostControlSettingPolicy =>
    snapshot.settings["*"] ?? { state: snapshot.defaults.setting };
  const actionPolicy = (action: string): HostControlActionPolicy =>
    lookupHierarchicalPolicy(snapshot.actions, action) ?? { state: snapshot.defaults.action };

  return {
    get snapshot() {
      return snapshot;
    },
    replace(policy) {
      snapshot = normalizeHostControlPolicy(policy);
      publish();
    },
    async refresh(basePath) {
      const next = await loadPolicyFromConfig(basePath);
      if (next !== null) {
        snapshot = normalizeHostControlPolicy(next);
        publish();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    routePolicy,
    routeState: (routeId) => routePolicy(routeId).state,
    isRouteEnabled: (routeId) => routePolicy(routeId).state !== "disabled",
    settingPolicy,
    settingState: (path) => settingPolicy(path).state,
    isSettingEditable: (path) => settingPolicy(path).state === "editable",
    actionPolicy,
    actionState: (action) => actionPolicy(action).state,
    canInvokeAction: (action) => actionPolicy(action).state === "enabled",
    preflightAction(action) {
      const policy = actionPolicy(action);
      if (policy.state === "enabled") {
        return { ok: true };
      }
      return {
        ok: false,
        code: "HOST_POLICY_BLOCKED",
        message:
          policy.state === "brokered"
            ? `Gateway action '${action}' must be brokered by the host.`
            : `Gateway action '${action}' is disabled by the host.`,
        details: {
          action,
          state: policy.state,
          reason: policy.reason,
        },
      };
    },
  };
}
