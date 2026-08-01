// Applies plugin middleware to agent tool results at runtime boundaries.
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareOptions,
  AgentToolResultMiddlewareRuntime,
  AgentToolResultMiddlewareScope,
} from "./agent-tool-result-middleware-types.js";
import type { PluginAgentToolResultMiddlewareRegistration } from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";
import {
  createPluginToolMatcherScope,
  normalizePluginToolMatcher,
  pluginToolMatcherCoversTool,
  type PluginToolMatcherScope,
} from "./tool-hook-matcher.js";

const AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIMES = [
  "openclaw",
  "codex",
] as const satisfies AgentToolResultMiddlewareRuntime[];

const AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIME_SET = new Set<string>(
  AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIMES,
);

function normalizeAgentToolResultMiddlewareRuntime(
  runtime: string,
): AgentToolResultMiddlewareRuntime | undefined {
  const normalized = runtime.trim().toLowerCase();
  return AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIME_SET.has(normalized)
    ? (normalized as AgentToolResultMiddlewareRuntime)
    : undefined;
}

export function normalizeAgentToolResultMiddlewareRuntimes(
  options?: AgentToolResultMiddlewareOptions,
): AgentToolResultMiddlewareRuntime[] {
  const requested = options?.runtimes;
  if (!requested) {
    return [...AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIMES];
  }
  const normalized: AgentToolResultMiddlewareRuntime[] = [];
  for (const runtime of requested) {
    const value = normalizeAgentToolResultMiddlewareRuntime(runtime);
    if (!value) {
      continue;
    }
    if (!normalized.includes(value)) {
      normalized.push(value);
    }
  }
  return normalized;
}
export function normalizeAgentToolResultMiddlewareRuntimeIds(
  runtimes: readonly string[] | undefined,
): AgentToolResultMiddlewareRuntime[] {
  const normalized: AgentToolResultMiddlewareRuntime[] = [];
  for (const runtime of runtimes ?? []) {
    const value = normalizeAgentToolResultMiddlewareRuntime(runtime);
    if (value && !normalized.includes(value)) {
      normalized.push(value);
    }
  }
  return normalized;
}

function sameMiddlewareScope(
  left: AgentToolResultMiddlewareScope,
  right: AgentToolResultMiddlewareScope,
): boolean {
  return (
    left.runtimes.length === right.runtimes.length &&
    left.runtimes.every((runtime) => right.runtimes.includes(runtime)) &&
    (left.matcher ?? []).length === (right.matcher ?? []).length &&
    (left.matcher ?? []).every((toolName) => right.matcher?.includes(toolName))
  );
}

function readAgentToolResultMiddlewareScopes(
  registration: PluginAgentToolResultMiddlewareRegistration,
): AgentToolResultMiddlewareScope[] {
  return registration.scopes?.length ? registration.scopes : [{ runtimes: registration.runtimes }];
}

export function appendAgentToolResultMiddlewareScope(
  registration: PluginAgentToolResultMiddlewareRegistration,
  scope: AgentToolResultMiddlewareScope,
): void {
  const normalizedMatcher = normalizePluginToolMatcher(scope.matcher);
  const normalizedScope: AgentToolResultMiddlewareScope = {
    runtimes: [...scope.runtimes],
    ...(normalizedMatcher ? { matcher: normalizedMatcher } : {}),
  };
  const scopes = readAgentToolResultMiddlewareScopes(registration);
  if (!scopes.some((existing) => sameMiddlewareScope(existing, normalizedScope))) {
    registration.scopes = [...scopes, normalizedScope];
  } else if (!registration.scopes) {
    registration.scopes = scopes;
  }
  registration.runtimes = normalizeAgentToolResultMiddlewareRuntimeIds(
    readAgentToolResultMiddlewareScopes(registration).flatMap((entry) => entry.runtimes),
  );
}

export function agentToolResultMiddlewareRegistrationCoversTool(
  registration: PluginAgentToolResultMiddlewareRegistration,
  runtime: AgentToolResultMiddlewareRuntime,
  toolName: string,
): boolean {
  return readAgentToolResultMiddlewareScopes(registration).some(
    (scope) =>
      scope.runtimes.includes(runtime) && pluginToolMatcherCoversTool(scope.matcher, toolName),
  );
}

export function getAgentToolResultMiddlewareMatcherScope(
  runtime: AgentToolResultMiddlewareRuntime,
): PluginToolMatcherScope | undefined {
  const matchers = (getActivePluginRegistry()?.agentToolResultMiddlewares ?? []).flatMap(
    (registration) =>
      readAgentToolResultMiddlewareScopes(registration)
        .filter((scope) => scope.runtimes.includes(runtime))
        .map((scope) => scope.matcher),
  );
  return createPluginToolMatcherScope(matchers);
}

export function listAgentToolResultMiddlewares(
  runtime: AgentToolResultMiddlewareRuntime,
): AgentToolResultMiddleware[] {
  return (
    getActivePluginRegistry()
      ?.agentToolResultMiddlewares?.filter((entry) => entry.runtimes.includes(runtime))
      .map((entry) => entry.handler) ?? []
  );
}
