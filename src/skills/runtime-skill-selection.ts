import type { SessionSystemPromptReport } from "../config/sessions/types.js";

export type RuntimeSkillSelectionMarker = {
  kind: "skill_selection";
  schemaVersion: 1;
  agentId: string | null;
  sessionKey: string | null;
  sessionId: string | null;
  runId: string | null;
  selectedSkill?: string | null;
  selectedOverlay?: string | null;
  selectionSource: "explicit_trigger" | "natural_prompt" | "none";
  selectionConfidence: "deterministic" | "heuristic" | "none";
  selectionRule: "explicit_trigger" | "deterministic_guardrail" | "token_overlap" | "none";
  visibilityState: "selected" | "injected" | "not_visible";
  redaction: "metadata_only";
};

function isSkillName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function listPromptSkillNames(systemPromptReport?: SessionSystemPromptReport): string[] {
  const entries = Array.isArray(systemPromptReport?.skills?.entries)
    ? systemPromptReport.skills.entries
    : [];
  return entries
    .map((entry) => (typeof entry?.name === "string" ? entry.name.trim() : ""))
    .filter(isSkillName);
}

const STOP_WORDS = new Set([
  "about",
  "action",
  "agent",
  "allow",
  "also",
  "based",
  "before",
  "build",
  "context",
  "current",
  "description",
  "directly",
  "existing",
  "files",
  "message",
  "needs",
  "normal",
  "openclaw",
  "output",
  "please",
  "prompt",
  "request",
  "route",
  "should",
  "skill",
  "skills",
  "source",
  "state",
  "task",
  "their",
  "tools",
  "workflow",
]);

function normalizeToken(token: string): string {
  const value = token.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, "");
  if (value.length < 4 || STOP_WORDS.has(value)) {
    return "";
  }
  if (value.endsWith("ies") && value.length > 5) {
    return `${value.slice(0, -3)}y`;
  }
  if (value.endsWith("ing") && value.length > 6) {
    return value.slice(0, -3);
  }
  if (value.endsWith("ed") && value.length > 5) {
    return value.slice(0, -2);
  }
  if (value.endsWith("s") && value.length > 4) {
    return value.slice(0, -1);
  }
  return value;
}

function tokenize(text: unknown): string[] {
  return String(text ?? "")
    .split(/[^A-Za-z0-9]+/u)
    .map(normalizeToken)
    .filter(Boolean);
}

function listPromptSkillBlocks(
  skillsPrompt?: string,
): Array<{ name: string; description: string }> {
  const prompt = typeof skillsPrompt === "string" ? skillsPrompt.trim() : "";
  if (!prompt) {
    return [];
  }
  return Array.from(prompt.matchAll(/<skill>[\s\S]*?<\/skill>/giu))
    .map((match) => match[0] ?? "")
    .map((block) => ({
      name: block.match(/<name>\s*([^<]+?)\s*<\/name>/iu)?.[1]?.trim() || "",
      description: block.match(/<description>\s*([^<]+?)\s*<\/description>/iu)?.[1]?.trim() || "",
    }))
    .filter((entry) => isSkillName(entry.name));
}

function resolveExplicitSkill(prompt: string, visibleSkillNames: Set<string>): string | null {
  const match = prompt.trimStart().match(/^[/@$]([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:\s|$)/u);
  if (!match) {
    return null;
  }
  const candidate = match[1] ?? "";
  return visibleSkillNames.has(candidate) ? candidate : null;
}

const DETERMINISTIC_GUARDRAILS: Array<{ name: string; patterns: RegExp[] }> = [
  {
    name: "debug-toolkit",
    patterns: [
      /\b(?:debug|debugging|bug|regression|regresja|flaky|flake|failing\s+test|root\s+cause|stack\s+trace|reproduc(?:e|tion)|diagnose|diagnoz|awaria|blad)\b/iu,
    ],
  },
  {
    name: "verification-before-completion-openclaw",
    patterns: [
      /\b(?:verify|verification|verified|weryfikacj|zweryfikuj|dowod|gotowe|naprawione|testy\s+przechodz)\b/iu,
    ],
  },
  {
    name: "runtime-skill-loading-diagnostics",
    patterns: [
      /\b(?:memorytunning|skill[-\s_]*selection|selectedskill|selectedoverlay|runtime[-\s_]*proven|runtime\s+skill|overlay\s+composed|skill\s+loading|observability|trajectory|openclaw\s+audit)\b/iu,
    ],
  },
];

function resolveDeterministicGuardrail(
  prompt: string,
  visibleSkillNames: Set<string>,
): string | null {
  for (const rule of DETERMINISTIC_GUARDRAILS) {
    if (!visibleSkillNames.has(rule.name)) {
      continue;
    }
    if (rule.patterns.some((pattern) => pattern.test(prompt))) {
      return rule.name;
    }
  }
  return null;
}

function resolveNaturalSkill(params: {
  prompt: string;
  skillsPrompt?: string;
  visibleSkillNames: Set<string>;
}): string | null {
  const promptTokens = new Set(tokenize(params.prompt));
  if (promptTokens.size === 0) {
    return null;
  }
  const skillBlocks = listPromptSkillBlocks(params.skillsPrompt).filter((entry) =>
    params.visibleSkillNames.has(entry.name),
  );
  let best: { name: string; score: number } | null = null;
  let tied = false;
  for (const entry of skillBlocks) {
    const nameTokens = new Set(tokenize(entry.name));
    const descriptionTokens = new Set(tokenize(entry.description));
    let score = 0;
    for (const token of nameTokens) {
      if (promptTokens.has(token)) {
        score += 3;
      }
    }
    for (const token of descriptionTokens) {
      if (promptTokens.has(token)) {
        score += 1;
      }
    }
    if (score === 0) {
      continue;
    }
    if (!best || score > best.score) {
      best = { name: entry.name, score };
      tied = false;
    } else if (score === best.score) {
      tied = true;
    }
  }
  if (!best || tied || best.score < 3) {
    return null;
  }
  return best.name;
}

function isOverlaySelectionName(name: string | null | undefined): boolean {
  return typeof name === "string" && /(?:^|[-_.])overlay(?:$|[-_.])/u.test(name.toLowerCase());
}

export function buildRuntimeSkillSelectionMarker(params: {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  prompt: string;
  systemPromptReport?: SessionSystemPromptReport;
  skillsPrompt?: string;
}): RuntimeSkillSelectionMarker {
  const visibleSkillNames = new Set(listPromptSkillNames(params.systemPromptReport));
  const explicitSkill = resolveExplicitSkill(params.prompt, visibleSkillNames);
  const guardrailSkill = explicitSkill
    ? null
    : resolveDeterministicGuardrail(params.prompt, visibleSkillNames);
  const naturalSkill =
    explicitSkill || guardrailSkill
      ? null
      : resolveNaturalSkill({
          prompt: params.prompt,
          skillsPrompt: params.skillsPrompt,
          visibleSkillNames,
        });
  const selectedName = explicitSkill ?? guardrailSkill ?? naturalSkill;
  const selectedOverlay = isOverlaySelectionName(selectedName) ? selectedName : null;
  const selectedSkill = selectedOverlay ? null : selectedName;
  return {
    kind: "skill_selection",
    schemaVersion: 1,
    agentId: params.agentId ?? null,
    sessionKey: params.sessionKey ?? null,
    sessionId: params.sessionId ?? null,
    runId: params.runId ?? null,
    selectedSkill,
    selectedOverlay,
    selectionSource: explicitSkill ? "explicit_trigger" : selectedName ? "natural_prompt" : "none",
    selectionConfidence:
      explicitSkill || guardrailSkill ? "deterministic" : naturalSkill ? "heuristic" : "none",
    selectionRule: explicitSkill
      ? "explicit_trigger"
      : guardrailSkill
        ? "deterministic_guardrail"
        : naturalSkill
          ? "token_overlap"
          : "none",
    visibilityState: selectedName
      ? "selected"
      : visibleSkillNames.size > 0
        ? "injected"
        : "not_visible",
    redaction: "metadata_only",
  };
}
