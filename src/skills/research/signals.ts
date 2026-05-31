import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import { compactWhitespace, extractTranscriptText } from "./text.js";

const CORRECTION_PATTERNS = [
  /\bnext time\b/i,
  /\bfrom now on\b/i,
  /\bremember to\b/i,
  /\bmake sure to\b/i,
  /\balways\b.{0,80}\b(use|check|verify|record|save|prefer)\b/i,
  /\bprefer\b.{0,120}\b(when|for|instead|use)\b/i,
  /\bwhen asked\b/i,
];

type DurableInstruction = {
  skillName: string;
  description: string;
  content: string;
  goal: string;
  evidence: string;
};

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
  if (/\bpr\b|\bpull request\b|\bgithub\b/.test(lower)) {
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

export function extractDurableInstructionProposal(params: {
  messages: unknown[];
}): DurableInstruction | undefined {
  const transcript = extractTranscriptText(params.messages);
  const userTexts = transcript.filter((entry) => entry.role === "user").map((entry) => entry.text);
  const instruction = userTexts.map(extractInstruction).findLast(Boolean);
  if (!instruction) {
    return undefined;
  }
  const topic = inferTopic(instruction);
  const skillName = normalizeSkillIndexName(topic.skillName);
  if (!skillName) {
    return undefined;
  }
  return {
    skillName,
    description: `Reusable workflow notes for ${topic.label}.`,
    goal: `Capture durable user correction for ${topic.label}.`,
    evidence: instruction,
    content: [
      `# ${topic.title}`,
      "",
      "## Workflow",
      "",
      `- ${instruction}`,
      "- Verify the result before final reply.",
      "- Record durable pitfalls as short bullets; avoid copying transcript noise.",
    ].join("\n"),
  };
}
