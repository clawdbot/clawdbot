import type { ExplicitSkillSelection, SkillUsagePath } from "../../../skills/types.js";

export function renderExplicitSkillPrompt(params: {
  prompt: string;
  selections: ExplicitSkillSelection[] | undefined;
  sandboxed: boolean;
  usagePaths: SkillUsagePath[] | undefined;
}): string {
  if (!params.selections?.length) {
    return params.prompt;
  }
  const pathsByFile = new Map(
    (params.usagePaths ?? []).map((entry) => [entry.skillFile, entry.readPath] as const),
  );
  const lines = params.selections.map((selection) => {
    const readPath =
      pathsByFile.get(selection.path) ?? (params.sandboxed ? undefined : selection.path);
    if (!readPath) {
      throw new Error(`Explicit skill is unavailable in the OpenClaw harness: ${selection.name}`);
    }
    return `- ${selection.name}: ${readPath}`;
  });
  return [
    "Use the following explicitly referenced skills for this request. Read each skill's SKILL.md before acting:",
    ...lines,
    "",
    "User request:",
    params.prompt,
  ].join("\n");
}
