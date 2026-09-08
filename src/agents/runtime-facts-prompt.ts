/** Compact current-turn snapshots; instructions belong in the stable system prompt. */
import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadExecApprovals, resolveExecApprovalsFromFile } from "../infra/exec-approvals.js";
import { listActiveProcessSessionReferences } from "./bash-process-references.js";
import { resolveProcessToolScopeKey } from "./bash-process-scope.js";
import type { RuntimeContextFragment } from "./internal-runtime-context.js";
import {
  buildActiveImageGenerationTaskPromptContextForSession,
  buildActiveMusicGenerationTaskPromptContextForSession,
  buildActiveVideoGenerationTaskPromptContextForSession,
} from "./media-generation-task-status.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";
import { buildActiveSubagentRuntimeContext } from "./subagents/registry/subagent-active-context.js";

type RuntimeFactsParams = {
  capabilityToolNames: ReadonlySet<string>;
  sessionKey?: string;
  sessionId?: string;
  agentId: string;
  cfg: OpenClawConfig;
};

/** Shared by embedded carriers and CLI current-turn context. */
export function buildMediaTaskRuntimeContext(
  params: Pick<RuntimeFactsParams, "capabilityToolNames" | "sessionKey" | "agentId">,
): string | undefined {
  const sections = [
    ["image_generate", buildActiveImageGenerationTaskPromptContextForSession],
    ["music_generate", buildActiveMusicGenerationTaskPromptContextForSession],
    ["video_generate", buildActiveVideoGenerationTaskPromptContextForSession],
  ] as const;
  const facts = sections
    .filter(([tool]) => params.capabilityToolNames.has(tool))
    .map(([tool, build]) => build(params.sessionKey, params.agentId) ?? `- tool=${tool}; none`);
  return facts.length ? ["## Media Generation Tasks", ...facts].join("\n") : undefined;
}

function buildApprovedExecutablesRuntimeContext(agentId: string): string {
  const header = "## Approved executables";
  try {
    const { allowlist } = resolveExecApprovalsFromFile({ file: loadExecApprovals(), agentId });
    const hints = allowlist
      .flatMap((entry) => {
        const pattern = entry.pattern.trim();
        if (pattern.startsWith("=command:") || !/[\\/~]/.test(pattern)) {
          return [];
        }
        // Keep absolute approval tokens exact; a basename can resolve to another binary.
        const name = path.win32.isAbsolute(pattern)
          ? pattern
          : path.win32.basename(pattern).replace(/\.exe$/i, "");
        // Omit hints that cannot be displayed faithfully within the prompt budget.
        if (!name || name.length > 256 || sanitizeForPromptLiteral(name) !== name) {
          return [];
        }
        return [`  ${name} ${entry.argPattern ? "(restricted args)" : "(any arguments)"}`];
      })
      .toSorted()
      .slice(0, 10);
    return [
      header,
      ...(hints.length
        ? [
            "Pre-approved executables (exact arguments are enforced at runtime; no approval prompt needed when args match):",
            ...hints,
          ]
        : ["none"]),
    ].join("\n");
  } catch {
    // Hints are advisory; approval loading must not block prompt preparation.
    return `${header}\nunavailable`;
  }
}

export function buildRuntimeFactsContext(params: RuntimeFactsParams): RuntimeContextFragment[] {
  const sections: string[] = [];
  if (process.platform === "win32" && params.capabilityToolNames.has("exec")) {
    sections.push(buildApprovedExecutablesRuntimeContext(params.agentId));
  }
  if (params.capabilityToolNames.has("process")) {
    const sessions = listActiveProcessSessionReferences({
      scopeKey: resolveProcessToolScopeKey(params),
    }).toSorted((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
    sections.push(
      [
        "Active exec sessions:",
        ...(sessions.length
          ? sessions.map((session) => {
              const pid = typeof session.pid === "number" ? ` pid=${session.pid}` : "";
              const cwd = session.cwd
                ? ` cwd=${truncateUtf16Safe(sanitizeForPromptLiteral(session.cwd), 256)}`
                : "";
              return `- ${session.sessionId} ${session.status}${pid}${cwd} :: ${sanitizeForPromptLiteral(session.name)}`;
            })
          : ["none"]),
      ].join("\n"),
    );
  }
  if (params.capabilityToolNames.has("sessions_spawn")) {
    sections.push(
      buildActiveSubagentRuntimeContext({
        cfg: params.cfg,
        controllerSessionKey: params.sessionKey,
        controllerAgentId: params.agentId,
      }) ?? "## Active Subagents\nnone",
    );
  }
  const media = buildMediaTaskRuntimeContext(params);
  if (media) {
    sections.push(media);
  }
  return sections.map((text) => ({ kind: "conversation-data", text }));
}
