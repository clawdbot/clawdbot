import { randomUUID } from "node:crypto";
import { compactWhitespace, extractTranscriptText } from "./text.js";
import type { SkillProposal } from "./types.js";

const CORRECTION_PATTERNS = [
  /\bnext time\b/i,
  /\bfrom now on\b/i,
  /\bremember to\b/i,
  /\bmake sure to\b/i,
  /\balways\b.{0,80}\b(use|check|verify|record|save|prefer)\b/i,
  /\bprefer\b.{0,120}\b(when|for|instead|use)\b/i,
  /\bwhen asked\b/i,
];

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

export function createProposalFromMessages(params: {
  messages: unknown[];
  workspaceDir: string;
  agentId?: string;
  sessionId?: string;
}): SkillProposal | undefined {
  const transcript = extractTranscriptText(params.messages);
  const userTexts = transcript.filter((entry) => entry.role === "user").map((entry) => entry.text);
  const instruction = userTexts.map(extractInstruction).findLast(Boolean);
  if (!instruction) {
    return undefined;
  }
  const topic = inferTopic(instruction);
  const now = Date.now();
  return {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    workspaceDir: params.workspaceDir,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    skillName: topic.skillName,
    title: topic.title,
    reason: `User correction for ${topic.label}`,
    source: "agent_end",
    status: "pending",
    change: {
      kind: "create",
      description: `Reusable workflow notes for ${topic.label}.`,
      body: [
        `# ${topic.title}`,
        "",
        "## Workflow",
        "",
        `- ${instruction}`,
        "- Verify the result before final reply.",
        "- Record durable pitfalls as short bullets; avoid copying transcript noise.",
      ].join("\n"),
    },
  };
}
