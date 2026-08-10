import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { RunSkillUsage } from "../runtime/run-usage.js";
import { SKILL_REVIEW_POLICY_PROMPT } from "./review-policy.js";
import { SKILL_AUTHORING_STANDARDS_PROMPT } from "./skill-authoring-standards.js";

const EXPERIENCE_REVIEW_MAX_TRANSCRIPT_CHARS = 60_000;
const EXPERIENCE_REVIEW_MAX_SKILL_ENTRIES = 50;
const EXPERIENCE_REVIEW_MAX_SKILL_LINE_CHARS = 200;
const EXPERIENCE_REVIEW_MAX_USED_SKILLS_CHARS = 2_000;

type ExperienceReviewPromptCandidate = {
  ctx: { runId?: string };
  transcript: string;
  modelIterations: number;
  turnAborted?: boolean;
  usedSkills?: readonly RunSkillUsage[];
  existingSkills?: readonly {
    name: string;
    description?: string;
    consolidationEligible: boolean;
  }[];
};

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function selectCurrentSkillTurnMessages(messages: readonly unknown[]): readonly unknown[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && message.role === "user") {
      return messages.slice(index);
    }
  }
  return messages;
}

export function countSkillModelIterations(messages: readonly unknown[]): number {
  return messages.reduce<number>(
    (count, message) => count + (isRecord(message) && message.role === "assistant" ? 1 : 0),
    0,
  );
}

function renderContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return safeJson(content);
  }
  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (!isRecord(block)) {
        return safeJson(block);
      }
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (["toolCall", "tool_use", "function_call"].includes(String(block.type))) {
        const toolName = typeof block.name === "string" ? block.name : "unknown";
        return `[tool call: ${toolName}] ${safeJson(
          block.arguments ?? block.input ?? block.args ?? {},
        )}`;
      }
      return safeJson(block);
    })
    .join("\n");
}

function renderMessage(message: unknown): string {
  if (!isRecord(message)) {
    return `[unknown]\n${safeJson(message)}`;
  }
  const role = typeof message.role === "string" ? message.role : "unknown";
  const error = message.isError === true ? " error" : "";
  const toolName = typeof message.toolName === "string" ? ` ${message.toolName}` : "";
  return `[${role}${toolName}${error}]\n${renderContent(message.content)}`;
}

export function formatSkillExperienceReviewTranscript(messages: readonly unknown[]): string {
  const rendered = messages.map(renderMessage);
  const full = rendered.join("\n\n");
  if (full.length <= EXPERIENCE_REVIEW_MAX_TRANSCRIPT_CHARS) {
    return full;
  }
  const first = truncateUtf16Safe(rendered[0] ?? "", 6_000);
  const tailBudget = EXPERIENCE_REVIEW_MAX_TRANSCRIPT_CHARS - first.length - 80;
  return `${first}\n\n[older trajectory omitted]\n\n${sliceUtf16Safe(full, -tailBudget)}`;
}

function renderExistingSkillsSection(
  existingSkills: ExperienceReviewPromptCandidate["existingSkills"],
): string[] {
  if (!existingSkills?.length) {
    return [];
  }
  const shown = existingSkills.slice(0, EXPERIENCE_REVIEW_MAX_SKILL_ENTRIES);
  const omitted = existingSkills.length - shown.length;
  return [
    "",
    "Existing workspace skills (update targets):",
    ...shown.map((skill) =>
      truncateUtf16Safe(
        `- ${skill.name} [${skill.consolidationEligible ? "may be superseded" : "update target only; cannot be superseded"}]${skill.description ? ` — ${skill.description}` : ""}`,
        EXPERIENCE_REVIEW_MAX_SKILL_LINE_CHARS,
      ),
    ),
    ...(omitted > 0 ? [`(+${omitted} more not shown)`] : []),
  ];
}

function compareRunSkillUsage(left: RunSkillUsage, right: RunSkillUsage): number {
  for (const field of ["name", "source", "activation"] as const) {
    if (left[field] !== right[field]) {
      return left[field] < right[field] ? -1 : 1;
    }
  }
  return 0;
}

function renderUsedSkillsSection(
  usedSkills: ExperienceReviewPromptCandidate["usedSkills"],
): string[] {
  if (!usedSkills?.length) {
    return [];
  }
  const shown = usedSkills
    .toSorted(compareRunSkillUsage)
    .slice(0, EXPERIENCE_REVIEW_MAX_SKILL_ENTRIES);
  const header = "Skills actually used in this trajectory (authoritative runtime receipt):";
  const preference =
    "Prefer improving a used writable workspace skill when it governs the learning.";
  const reservedOmission = `(+${usedSkills.length} more used skills omitted)`;
  const entries: string[] = [];
  for (const skill of shown) {
    const line = truncateUtf16Safe(
      `- ${skill.name} (${skill.source}, ${skill.activation})`,
      EXPERIENCE_REVIEW_MAX_SKILL_LINE_CHARS,
    );
    if (
      ["", header, ...entries, line, reservedOmission, preference].join("\n").length >
      EXPERIENCE_REVIEW_MAX_USED_SKILLS_CHARS
    ) {
      break;
    }
    entries.push(line);
  }
  const omitted = usedSkills.length - entries.length;
  return [
    "",
    header,
    ...entries,
    ...(omitted > 0 ? [`(+${omitted} more used skills omitted)`] : []),
    preference,
  ];
}

export function buildSkillExperienceReviewPrompt(
  candidate: ExperienceReviewPromptCandidate,
): string {
  return [
    "Review this agent turn after the foreground run has ended.",
    "",
    "Use skill_workshop to mutate a proposal when at least one condition has concrete evidence in the trajectory:",
    "- the model struggled, took a wrong path, needed correction, repeated failures, or found a reusable recovery technique;",
    "- the user gave a durable correction or standing instruction ('from now on', 'always X', 'never Y', 'stop doing Z', 'I told you') — embed the rule in the skill governing that work, stated as a complete procedure step in your own words, never as the user's message quoted back; or",
    "- a stable procedure would remove at least two future model/tool round trips; or",
    "- the existing workspace list suggests overlapping skills and a complete read shows that one survivor can preserve their useful procedures.",
    "",
    SKILL_REVIEW_POLICY_PROMPT,
    "",
    SKILL_AUTHORING_STANDARDS_PROMPT,
    "",
    "Choose the smallest valid mutation: patch a used writable workspace skill that governs this work before another existing skill. Read before patch/update/consolidation, quote the exact text to change, and match the survivor's style. Make at most one create/patch/update/revise call. Every mutation starts as a pending proposal; nothing writes a live skill during this review, and the configured pipeline decides whether to apply it afterward.",
    "",
    candidate.turnAborted === true
      ? `Interrupted run (stopped before completion): ${candidate.ctx.runId ?? "unknown"}`
      : `Completed run: ${candidate.ctx.runId ?? "unknown"}`,
    ...(candidate.turnAborted === true
      ? [
          "The trajectory may end mid-task. Only capture procedures that visibly worked before the interruption.",
        ]
      : []),
    ...renderUsedSkillsSection(candidate.usedSkills),
    ...renderExistingSkillsSection(candidate.existingSkills),
    `Model iterations in turn: ${candidate.modelIterations}`,
    "",
    "Trajectory:",
    candidate.transcript,
  ].join("\n");
}
