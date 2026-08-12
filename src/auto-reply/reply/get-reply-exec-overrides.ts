/** Resolves effective exec-tool overrides for reply runs. */
import type { ExecToolDefaults } from "../../agents/bash-tools.js";
import { resolveExecToolConfig } from "../../agents/lazy-exec-tool.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { InlineDirectives } from "./directive-handling.parse.js";

/** Exec defaults that can be overridden by inline directives or session state. */
export type ReplyExecOverrides = Pick<
  ExecToolDefaults,
  "host" | "mode" | "security" | "ask" | "node" | "nodeCwd"
>;

/**
 * Project canonical `tools.exec` resolution into reply-session defaults (#112376).
 *
 * New Dashboard/WebChat sessions have no session-level exec fields yet, so the
 * previous `agentEntry?.tools?.exec` lookup silently dropped the global
 * `tools.exec` layer and any policy-file layering. Reusing `resolveExecToolConfig`
 * keeps fresh sessions aligned with the same precedence coding tools already use.
 * `nodeCwd` is intentionally left out here: it is session/runtime-scoped only and
 * must not be seeded from persistent config.
 */
export function resolveConfigExecDefaults(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): ReplyExecOverrides | undefined {
  const execConfig = resolveExecToolConfig({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const { host, mode, security, ask, node } = execConfig;
  if (!host && !mode && !security && !ask && !node) {
    return undefined;
  }
  return { host, ...(mode ? { mode } : {}), security, ask, node };
}

/** Resolves effective exec defaults for a reply run. */
export function resolveReplyExecOverrides(params: {
  directives: InlineDirectives;
  sessionEntry?: SessionEntry;
  agentExecDefaults?: ReplyExecOverrides;
}): ReplyExecOverrides | undefined {
  const host =
    params.directives.execHost ??
    (params.sessionEntry?.execHost as ReplyExecOverrides["host"]) ??
    params.agentExecDefaults?.host;
  // Inline /exec directives and legacy session fields only ever carry
  // security/ask, not mode. Once either layer supplies an explicit
  // security/ask override, drop the config-derived mode rather than let a
  // stale mode (e.g. mode:auto) mismatch the now-overridden policy.
  const hasSessionOrInlinePolicy =
    params.directives.execSecurity !== undefined ||
    params.directives.execAsk !== undefined ||
    params.sessionEntry?.execSecurity !== undefined ||
    params.sessionEntry?.execAsk !== undefined;
  const mode = hasSessionOrInlinePolicy ? undefined : params.agentExecDefaults?.mode;
  const security =
    params.directives.execSecurity ??
    (params.sessionEntry?.execSecurity as ReplyExecOverrides["security"]) ??
    params.agentExecDefaults?.security;
  const ask =
    params.directives.execAsk ??
    (params.sessionEntry?.execAsk as ReplyExecOverrides["ask"]) ??
    params.agentExecDefaults?.ask;
  const node =
    params.directives.execNode ?? params.sessionEntry?.execNode ?? params.agentExecDefaults?.node;
  const nodeCwd =
    node && node === params.sessionEntry?.execNode ? params.sessionEntry.execCwd : undefined;
  if (!host && !mode && !security && !ask && !node && !nodeCwd) {
    return undefined;
  }
  return {
    host,
    ...(mode ? { mode } : {}),
    security,
    ask,
    node,
    ...(nodeCwd ? { nodeCwd } : {}),
  };
}
