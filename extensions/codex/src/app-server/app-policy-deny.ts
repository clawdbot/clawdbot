/**
 * Applies host-certified `mcp__codex_apps__<literal>*` denies to the apps
 * OpenClaw admits into a native Codex thread.
 */
import { readCodexAppToolsByConnector } from "./app-tool-inventory.js";
import { resolveCodexAppModelToolNamesByConnector } from "./codex-app-tool-names.js";
import type { ResolvedCodexPluginPolicy } from "./config.js";

/** Model-facing prefix Codex gives every shared `codex_apps` tool. */
export const CODEX_APPS_TOOL_NAME_PREFIX = "mcp__codex_apps__";

export type CodexAppDenyDecision = "allowed" | "denied" | "unenforceable";

/** Diagnostic emitted when tool policy removes or cannot safely scope a Codex app. */
export type CodexAppDenyDiagnostic = {
  code: "app_denied_by_policy" | "app_policy_unenforceable";
  plugin?: ResolvedCodexPluginPolicy;
  message: string;
};

export function buildCodexAppDeniedDiagnostic(
  appId: string,
  plugin?: ResolvedCodexPluginPolicy,
): CodexAppDenyDiagnostic {
  return {
    code: "app_denied_by_policy",
    ...(plugin ? { plugin } : {}),
    message: `${appId} is denied by tool policy.`,
  };
}

export function buildCodexAppDenyUnenforceableDiagnostic(appId: string): CodexAppDenyDiagnostic {
  return {
    code: "app_policy_unenforceable",
    message: `Tool policy could not be applied to every tool of Codex app ${appId}; Codex apps were disabled for this turn. Deny the whole app (${CODEX_APPS_TOOL_NAME_PREFIX}<app>_*) or allow it.`,
  };
}

export function buildCodexAppDenyUnmanagedDiagnostic(
  patterns: readonly string[],
): CodexAppDenyDiagnostic {
  return {
    code: "app_policy_unenforceable",
    message: `Tool policy denies ${patterns.join(", ")} but codexPlugins is not enabled, so OpenClaw cannot admit apps selectively; Codex apps were disabled for this turn. Enable codexPlugins with allow_all_plugins to scope apps per agent.`,
  };
}

export function buildCodexAppDenyUnmatchedDiagnostic(
  patterns: readonly string[],
): CodexAppDenyDiagnostic {
  return {
    code: "app_policy_unenforceable",
    message: `Tool policy denies ${patterns.join(", ")} but no connected Codex app exposes a matching tool; Codex apps were disabled for this turn. Check the app namespace in the tool names Codex exposes, or remove the deny.`,
  };
}

/** Lowercases, dedupes, and sorts patterns so fingerprints and decisions agree. */
export function normalizeCodexDeniedAppPatterns(patterns: readonly string[] | undefined): string[] {
  if (!patterns?.length) {
    return [];
  }
  return [
    ...new Set(
      patterns
        .map((pattern) => pattern.trim().toLowerCase())
        .filter(
          (pattern) =>
            pattern.startsWith(CODEX_APPS_TOOL_NAME_PREFIX) &&
            pattern.endsWith("*") &&
            !pattern.slice(CODEX_APPS_TOOL_NAME_PREFIX.length, -1).includes("*"),
        ),
    ),
  ].toSorted();
}

/**
 * Reads the app tool inventory only when denies need it and resolves the
 * model-visible name of every tool the way Codex does. An unreadable inventory
 * yields undefined so every gated app fails closed.
 */
export async function readCodexAppModelToolNamesForDenies(params: {
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  threadId?: string;
  patterns: readonly string[];
}): Promise<ReadonlyMap<string, readonly string[]> | undefined> {
  if (params.patterns.length === 0) {
    return new Map();
  }
  return await readCodexAppToolsByConnector(params)
    .then(resolveCodexAppModelToolNamesByConnector)
    .catch(() => undefined);
}

/**
 * Returns the patterns that match no tool of any known app. Codex does not
 * expose model-facing app tool names over the protocol, so a deny that matches
 * nothing may be a misspelling or a naming change; either way it must not be
 * treated as satisfied.
 */
export function findUnmatchedCodexAppDenyPatterns(params: {
  modelToolNamesByApp: ReadonlyMap<string, readonly string[]>;
  patterns: readonly string[];
}): string[] {
  const modelToolNames = [...params.modelToolNamesByApp.values()].flat();
  return params.patterns.filter((pattern) => {
    const literal = pattern.slice(0, -1);
    return !modelToolNames.some((modelToolName) => modelToolName.startsWith(literal));
  });
}

/**
 * Decides whether the patterns deny every model-visible tool of one app. A
 * pattern covering every tool denies the app; one covering only some tools has
 * no projectable form and fails closed, as does an app whose tools could not be read.
 */
export function resolveCodexAppDenyDecision(params: {
  modelToolNames: readonly string[] | undefined;
  patterns: readonly string[];
}): CodexAppDenyDecision {
  if (params.patterns.length === 0) {
    return "allowed";
  }
  if (!params.modelToolNames?.length) {
    return "unenforceable";
  }
  const literals = params.patterns.map((pattern) => pattern.slice(0, -1));
  const matched = params.modelToolNames.filter((modelToolName) =>
    literals.some((literal) => modelToolName.startsWith(literal)),
  ).length;
  if (matched === 0) {
    return "allowed";
  }
  return matched === params.modelToolNames.length ? "denied" : "unenforceable";
}

/**
 * Builds the per-app gate a thread config build runs before admitting an app.
 * `apply` returns false to admit, true to skip a denied app (recording a
 * diagnostic), or the caller's fail-closed config when the deny cannot be applied
 * exactly. `unmatched` lists patterns that touch no known app tool.
 */
export function createCodexAppDenyGate<T>(params: {
  modelToolNamesByApp: ReadonlyMap<string, readonly string[]> | undefined;
  patterns: readonly string[];
  onDenied: (diagnostic: CodexAppDenyDiagnostic) => void;
  failClosed: (appId: string) => T;
}): {
  apply: (appId: string, plugin?: ResolvedCodexPluginPolicy) => T | boolean;
  unmatched: string[];
} {
  return {
    unmatched: params.modelToolNamesByApp
      ? findUnmatchedCodexAppDenyPatterns({
          modelToolNamesByApp: params.modelToolNamesByApp,
          patterns: params.patterns,
        })
      : [],
    apply: (appId, plugin) => {
      const decision = resolveCodexAppDenyDecision({
        modelToolNames: params.modelToolNamesByApp?.get(appId),
        patterns: params.patterns,
      });
      if (decision === "denied") {
        params.onDenied(buildCodexAppDeniedDiagnostic(appId, plugin));
      }
      return decision === "unenforceable" ? params.failClosed(appId) : decision === "denied";
    },
  };
}
