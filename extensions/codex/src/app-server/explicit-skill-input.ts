import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { v2 } from "./protocol.js";

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export type CodexSkillInputPlan = {
  explicitSkillSelections: NonNullable<EmbeddedRunAttemptParams["explicitSkillSelections"]>;
  suppressedSkillNames: string[];
};

/** Resolves authorized selections and text suppression against the active Codex catalog. */
export async function resolveCodexSkillInputPlan(params: {
  client: CodexAppServerClient;
  cwd: string;
  preserveNativeSkillMentions?: boolean;
  selections: EmbeddedRunAttemptParams["explicitSkillSelections"];
  signal?: AbortSignal;
  text: string;
}): Promise<CodexSkillInputPlan> {
  const selections = params.selections ?? [];
  if (params.preserveNativeSkillMentions && selections.length === 0) {
    return { explicitSkillSelections: [], suppressedSkillNames: [] };
  }
  const mentionNames = new Set(
    [...params.text.matchAll(/\$([A-Za-z0-9_:-]+)/gu)].map((match) =>
      (match[1] ?? "").toLowerCase(),
    ),
  );
  if (selections.length === 0 && mentionNames.size === 0) {
    return { explicitSkillSelections: [], suppressedSkillNames: [] };
  }
  const response = (await params.client.request(
    "skills/list",
    { cwds: [params.cwd], forceReload: false } satisfies v2.SkillsListParams,
    { signal: params.signal },
  )) as v2.SkillsListResponse;
  const catalog = response.data.find(
    (entry) => path.resolve(entry.cwd) === path.resolve(params.cwd),
  );
  const resolved = selections.map((selection) => {
    const selectedPath = comparablePath(selection.path);
    const skill = catalog?.skills.find(
      (candidate) => comparablePath(candidate.path) === selectedPath && candidate.enabled,
    );
    if (!skill) {
      throw new Error(`Explicit skill is unavailable in the Codex harness: ${selection.name}`);
    }
    return {
      ...(selection.mention ? { mention: selection.mention } : {}),
      name: skill.name,
      path: skill.path,
    };
  });
  const suppressedSkillNames = params.preserveNativeSkillMentions
    ? []
    : ([
        ...new Set([
          ...(catalog?.skills.filter((skill) => skill.enabled).map((skill) => skill.name) ?? []),
          ...resolved.flatMap((selection) => [selection.name, selection.mention].filter(Boolean)),
        ]),
      ] as string[]);
  return { explicitSkillSelections: resolved, suppressedSkillNames };
}
