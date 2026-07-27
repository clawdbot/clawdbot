// Research signal helpers normalize skill names and extract research-worthy signals.
import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import { compactWhitespace, extractTranscriptText } from "./text.js";

// Durable signals arrive in two shapes: prospective rules ("from now on…") and reactive
// corrections ("that's not what I asked", "you're still using X", "I thought we were…").
// Reactive phrasing dominates real sessions — users mostly push back on what just happened
// rather than dictate future policy — so both shapes are captured.
const PROSPECTIVE_PATTERNS = [
  /\bnext time\b/i,
  /\bfrom now on\b/i,
  /\bgoing forward\b/i,
  /\bremember to\b/i,
  /\bmake sure to\b/i,
  /\balways\b.{0,80}\b(use|check|verify|record|save|prefer)\b/i,
  /\bprefer\b.{0,120}\b(when|for|instead|use)\b/i,
  /\bwhen asked\b/i,
];

const REACTIVE_PATTERNS = [
  /\b(?:that|this|it)(?:'s| is| was)? (?:wrong|not what i (?:asked|meant|said|wanted))\b/i,
  /\bdon'?t\b.{0,60}\bagain\b/i,
  /\bstop (?:using|doing|making|building|adding)\b/i,
  /\bstill (?:using|doing|making|ignoring)\b/i,
  /\b(?:i|we) (?:told|asked) you\b/i,
  /\brepeat myself\b/i,
  /\bshould (?:not|never) (?:have|be)\b/i,
  /\bi thought (?:we|you) (?:were|was|would|agreed)\b/i,
];

const CORRECTION_PATTERNS = [...PROSPECTIVE_PATTERNS, ...REACTIVE_PATTERNS];

// Bound the sweep so a long session can't flood the workshop with proposals.
const MAX_CAPTURED_INSTRUCTIONS = 8;
const DEFAULT_MAX_PROPOSALS = 3;
// An existing skill must share at least this much vocabulary before a correction routes to it.
const SKILL_MATCH_MIN_SCORE = 2;

const SKILL_MATCH_STOPWORDS = new Set([
  "and",
  "are",
  "before",
  "but",
  "for",
  "from",
  "have",
  "into",
  "not",
  "should",
  "that",
  "the",
  "them",
  "then",
  "they",
  "this",
  "was",
  "were",
  "what",
  "when",
  "with",
  "you",
  "your",
]);

type WorkspaceSkillSummary = {
  name: string;
  description?: string;
};

export type DurableInstruction = {
  skillName: string;
  description: string;
  content: string;
  goal: string;
  evidence: string;
  instructions: string[];
  existingSkill: boolean;
};

// Topic inference stays conservative so autocapture proposes broad skills, not brittle names.
function inferTopic(text: string): { skillName: string; title: string; label: string } {
  const lower = text.toLowerCase();
  if (/\banimated\b|\bgifs?\b/.test(lower)) {
    return {
      skillName: "animated-gif-workflow",
      title: "Animated GIF Workflow",
      label: "animated GIF requests",
    };
  }
  if (/\bscreenshot|screen capture|imageoptim|asset\b/.test(lower)) {
    return {
      skillName: "screenshot-asset-workflow",
      title: "Screenshot Asset Workflow",
      label: "screenshot asset updates",
    };
  }
  if (/\bqa\b|\bscenario\b|\btest plan\b/.test(lower)) {
    return { skillName: "qa-scenario-workflow", title: "QA Scenario Workflow", label: "QA tasks" };
  }
  if (/\bpr\b|\bpull requests?\b|\bgithub\b/.test(lower)) {
    return {
      skillName: "github-pr-workflow",
      title: "GitHub PR Workflow",
      label: "GitHub PR work",
    };
  }
  return { skillName: "learned-workflows", title: "Learned Workflows", label: "repeatable tasks" };
}

function extractInstruction(text: string): string | undefined {
  const trimmed = compactWhitespace(text);
  if (trimmed.length < 24 || trimmed.length > 1200) {
    return undefined;
  }
  if (!CORRECTION_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return undefined;
  }
  return trimmed.replace(/^ok[,. ]+/i, "");
}

function tokenizeForSkillMatch(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !SKILL_MATCH_STOPWORDS.has(token));
}

// Cheap singular/plural equivalence keeps "coaches" matching a "coach-distiller" skill
// without pulling in a stemmer.
function skillTokensMatch(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  return a === `${b}s` || b === `${a}s` || a === `${b}es` || b === `${a}es`;
}

// Routes a correction to the existing skill it is most plausibly about. Skill-name vocabulary
// counts double so "signal" routes to signal-scout even when the description barely overlaps.
function matchExistingSkill(
  instruction: string,
  skills: readonly WorkspaceSkillSummary[],
): WorkspaceSkillSummary | undefined {
  let best: WorkspaceSkillSummary | undefined;
  let bestScore = 0;
  const instructionTokens = new Set(tokenizeForSkillMatch(instruction));
  for (const skill of skills) {
    const nameTokens = tokenizeForSkillMatch(skill.name.replace(/-/g, " "));
    const descriptionTokens = tokenizeForSkillMatch(skill.description ?? "");
    let score = 0;
    for (const token of instructionTokens) {
      if (nameTokens.some((candidate) => skillTokensMatch(candidate, token))) {
        score += 2;
      } else if (descriptionTokens.some((candidate) => skillTokensMatch(candidate, token))) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = skill;
    }
  }
  return bestScore >= SKILL_MATCH_MIN_SCORE ? best : undefined;
}

function titleFromSkillName(skillName: string): string {
  return skillName
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildInstructionGroup(params: {
  skillName: string;
  title: string;
  label: string;
  instructions: string[];
  existingSkill: boolean;
}): DurableInstruction | undefined {
  const skillName = normalizeSkillIndexName(params.skillName);
  if (!skillName) {
    return undefined;
  }
  return {
    skillName,
    description: `Reusable workflow notes for ${params.label}.`,
    goal: `Capture durable user corrections for ${params.label}.`,
    evidence: params.instructions.join("\n"),
    instructions: [...params.instructions],
    existingSkill: params.existingSkill,
    content: [
      `# ${params.title}`,
      "",
      "## Workflow",
      "",
      ...params.instructions.map((instruction) => `- ${instruction}`),
      "- Verify the result before final reply.",
      "- Record durable pitfalls as short bullets; avoid copying transcript noise.",
    ].join("\n"),
  };
}

/**
 * Cheaply extracts candidate durable instructions from transcript text, newest last.
 */
export function extractDurableInstructions(messages: unknown[]): string[] {
  const transcript = extractTranscriptText(messages);
  const userTexts = transcript.filter((entry) => entry.role === "user").map((entry) => entry.text);
  const instructions: string[] = [];
  for (const text of userTexts) {
    const instruction = extractInstruction(text);
    if (instruction && !instructions.includes(instruction)) {
      instructions.push(instruction);
    }
  }
  return instructions.slice(-MAX_CAPTURED_INSTRUCTIONS);
}

/**
 * Routes and groups already-extracted instructions into one proposal per target skill.
 */
export function groupDurableInstructionProposals(params: {
  instructions: readonly string[];
  existingSkills?: readonly WorkspaceSkillSummary[];
  maxProposals?: number;
}): DurableInstruction[] {
  if (params.instructions.length === 0) {
    return [];
  }

  const groups = new Map<
    string,
    { title: string; label: string; instructions: string[]; existingSkill: boolean }
  >();
  for (const instruction of params.instructions) {
    const inferred = inferTopic(instruction);
    const existingSkills = params.existingSkills ?? [];
    const existing =
      matchExistingSkill(instruction, existingSkills) ??
      existingSkills.find((skill) => normalizeSkillIndexName(skill.name) === inferred.skillName);
    const topic = existing
      ? {
          skillName: existing.name,
          title: titleFromSkillName(existing.name),
          label: `the ${existing.name} skill`,
        }
      : inferred;
    const group = groups.get(topic.skillName);
    if (group) {
      group.instructions.push(instruction);
      // Re-insert so the recency cap ranks topics by their LATEST correction, not their first.
      groups.delete(topic.skillName);
      groups.set(topic.skillName, group);
    } else {
      groups.set(topic.skillName, {
        title: topic.title,
        label: topic.label,
        instructions: [instruction],
        existingSkill: Boolean(existing),
      });
    }
  }

  const maxProposals = params.maxProposals ?? DEFAULT_MAX_PROPOSALS;
  const proposals: DurableInstruction[] = [];
  // Most recent groups win when the cap bites — later corrections carry the freshest intent.
  for (const [skillName, group] of [...groups.entries()].slice(-maxProposals)) {
    const proposal = buildInstructionGroup({
      skillName,
      title: group.title,
      label: group.label,
      instructions: group.instructions,
      existingSkill: group.existingSkill,
    });
    if (proposal) {
      proposals.push(proposal);
    }
  }
  return proposals;
}
