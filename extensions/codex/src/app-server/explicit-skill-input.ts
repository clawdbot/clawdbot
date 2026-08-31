import path from "node:path";
import {
  embeddedAgentLog,
  formatErrorMessage,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { v2 } from "./protocol.js";

type CodexExplicitSkillInput = { type: "skill"; name: string; path: string };

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function resolveCodexExplicitSkillInputs(params: {
  client: CodexAppServerClient;
  cwd: string;
  selections: EmbeddedRunAttemptParams["explicitSkillSelections"];
  signal?: AbortSignal;
}): Promise<CodexExplicitSkillInput[]> {
  if (!params.selections?.length) {
    return [];
  }
  // The prompt instruction block owns skills unavailable to Codex, so misses and RPC errors
  // stay fail-open instead of blocking the turn.
  try {
    const response = (await params.client.request(
      "skills/list",
      { cwds: [params.cwd], forceReload: false } satisfies v2.SkillsListParams,
      { signal: params.signal },
    )) as v2.SkillsListResponse;
    const cwd = comparablePath(params.cwd);
    const catalog = response.data.find((entry) => comparablePath(entry.cwd) === cwd);
    return params.selections.flatMap((selection) => {
      const selectedPath = comparablePath(selection.path);
      const skill = catalog?.skills.find(
        (candidate) => candidate.enabled && comparablePath(candidate.path) === selectedPath,
      );
      return skill ? [{ type: "skill" as const, name: skill.name, path: skill.path }] : [];
    });
  } catch (error) {
    embeddedAgentLog.debug("codex explicit skill catalog unavailable; using prompt fallback", {
      error: formatErrorMessage(error),
    });
    return [];
  }
}
