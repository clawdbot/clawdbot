export type PublicOpinionBuiltinSkillName =
  | "ai-public-opinion-brief"
  | "gov-public-opinion-analysis-agent";

const bundledSkillNames = new Set([
  "infringement-judgment",
  "institution-violation-judgment",
  "gov-public-opinion-analysis-agent",
  "ai-public-opinion-brief",
  "ai-collaboration-diagnostic",
]);

/** Fail closed before execution even if a queue producer bypasses the web API. */
export async function validateBuiltinSkillSelection(
  name: string | undefined,
  isPublished?: (name: string) => Promise<boolean>,
): Promise<void> {
  if (!name || bundledSkillNames.has(name)) {
    return;
  }
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) ||
    name.length > 100 ||
    !isPublished ||
    !(await isPublished(name))
  ) {
    throw new Error("Selected built-in skill is not published or is disabled");
  }
}

const REQUEST_ACTION = "(?:请|帮我|给我|根据|围绕|针对|就|写|撰写|生成|形成|制作|出一份|更新|研判)";

const BRIEF_REQUEST = new RegExp(
  `${REQUEST_ACTION}.{0,28}(?:舆情)?(?:速报|快报|续报)|` +
    `(?:舆情)?(?:速报|快报|续报).{0,16}(?:写|撰写|生成|形成|制作|更新|报一下)`,
  "iu",
);

const FORMAL_REPORT_REQUEST = new RegExp(
  `${REQUEST_ACTION}.{0,36}(?:政务舆情分析报告|舆情分析报告|舆情研判报告|` +
    `网络舆情风险研判|领导参阅舆情|舆情专报)`,
  "iu",
);

/**
 * Deterministically route unmistakable public-opinion deliverables to the
 * bundled skill that owns their research and evidence discipline. Generic
 * mentions of public opinion and ordinary reports intentionally stay on the
 * normal agent path.
 */
export function inferBuiltinSkillName(message: string): PublicOpinionBuiltinSkillName | undefined {
  const normalized = message.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return undefined;
  }
  if (BRIEF_REQUEST.test(normalized)) {
    return "ai-public-opinion-brief";
  }
  if (FORMAL_REPORT_REQUEST.test(normalized)) {
    return "gov-public-opinion-analysis-agent";
  }
  return undefined;
}
