/** Resolves effective exec-tool overrides for reply runs. */
import type { ExecToolDefaults } from "../../agents/bash-tools.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { InlineDirectives } from "./directive-handling.parse.js";

/** Exec defaults that can be overridden by inline directives or session state. */
export type ReplyExecOverrides = Pick<
  ExecToolDefaults,
  "host" | "security" | "ask" | "node" | "nodeCwd"
>;

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
  if (!host && !security && !ask && !node && !nodeCwd) {
    return undefined;
  }
  return { host, security, ask, node, ...(nodeCwd ? { nodeCwd } : {}) };
}
