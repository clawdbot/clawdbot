import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveAgentEffectiveModelPrimary,
  resolveDefaultModelForAgent,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "../api.js";
import type { SkillWorkshopConfig } from "./config.js";
import { normalizeSkillName } from "./skills.js";
import { compactWhitespace, extractTranscriptText } from "./text.js";
import type { SkillChange, SkillProposal } from "./types.js";

const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_SKILL_CHARS = 2_000;
const MAX_SKILLS = 12;

type ReviewContext = {
  agentId: string;
  sessionId?: string;
  sessionKey?: string;
  workspaceDir: string;
  modelProviderId?: string;
  modelId?: string;
  messageProvider?: string;
  channelId?: string;
};

type ReviewerJson = {
  action?: string;
  skillName?: string;
  title?: string;
  reason?: string;
  description?: string;
  section?: string;
  body?: string;
  oldText?: string;
  newText?: string;
};

function resolveReviewerFallbackModel(params: { api: OpenClawPluginApi; agentId: string }): {
  provider: string;
  model: string;
} {
  if (resolveAgentEffectiveModelPrimary(params.api.config, params.agentId)) {
    return resolveDefaultModelForAgent({
      cfg: params.api.config,
      agentId: params.agentId,
    });
  }
  return {
    provider: params.api.runtime.agent.defaults.provider,
    model: params.api.runtime.agent.defaults.model,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseReviewerJson(raw: string): ReviewerJson | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const jsonText = match?.[1]?.trim() ?? trimmed;
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeAction(value: string | undefined): SkillChange["kind"] | "none" | undefined {
  if (value === "create" || value === "append" || value === "replace" || value === "none") {
    return value;
  }
  return undefined;
}

function proposalFromReviewerJson(params: {
  parsed: ReviewerJson;
  workspaceDir: string;
  agentId: string;
  sessionId?: string;
}): SkillProposal | undefined {
  const action = normalizeAction(readString(params.parsed.action));
  if (!action || action === "none") {
    return undefined;
  }
  const skillName = normalizeSkillName(readString(params.parsed.skillName) ?? "");
  if (!skillName) {
    return undefined;
  }
  const now = Date.now();
  const title = readString(params.parsed.title) ?? `Skill update: ${skillName}`;
  const reason = readString(params.parsed.reason) ?? "Review found reusable workflow";
  let change: SkillChange;
  if (action === "replace") {
    const oldText = readString(params.parsed.oldText);
    const newText = readString(params.parsed.newText);
    if (!oldText || !newText) {
      return undefined;
    }
    change = { kind: "replace", oldText, newText };
  } else {
    const body = readString(params.parsed.body);
    if (!body) {
      return undefined;
    }
    if (action === "append") {
      change = {
        kind: "append",
        section: readString(params.parsed.section) ?? "Workflow",
        body,
        description: readString(params.parsed.description) ?? title,
      };
    } else {
      change = {
        kind: "create",
        description: readString(params.parsed.description) ?? title,
        body,
      };
    }
  }
  return {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    workspaceDir: params.workspaceDir,
    agentId: params.agentId,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    skillName,
    title,
    reason,
    source: "reviewer",
    status: "pending",
    change,
  };
}

function countToolCallsInValue(value: unknown): number {
  if (!value || typeof value !== "object") {
    return 0;
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countToolCallsInValue(item), 0);
  }
  const record = value as Record<string, unknown>;
  let count = 0;
  if (Array.isArray(record.tool_calls)) {
    count += record.tool_calls.length;
  }
  if (record.type === "tool_call" || record.type === "function_call") {
    count += 1;
  }
  const content = record.content;
  if (Array.isArray(content)) {
    count += content.filter((block) => isRecord(block) && block.type === "tool_call").length;
  }
  return count;
}

export function countToolCalls(messages: unknown[]): number {
  return messages.reduce<number>((sum, message) => sum + countToolCallsInValue(message), 0);
}

function buildTranscript(messages: unknown[]): string {
  const entries = extractTranscriptText(messages);
  const text = entries
    .map((entry) => `${entry.role}: ${compactWhitespace(entry.text)}`)
    .join("\n")
    .slice(-MAX_TRANSCRIPT_CHARS);
  return text.trim() || "(no text transcript)";
}

async function readExistingSkills(workspaceDir: string): Promise<string> {
  const skillsDir = path.join(workspaceDir, "skills");
  let entries: Array<{ name: string; markdown: string }> = [];
  try {
    const dirents = await fs.readdir(skillsDir, { withFileTypes: true });
    const names = dirents
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted()
      .slice(0, MAX_SKILLS);
    entries = await Promise.all(
      names.map(async (name) => {
        const file = path.join(skillsDir, name, "SKILL.md");
        try {
          return { name, markdown: (await fs.readFile(file, "utf8")).slice(0, MAX_SKILL_CHARS) };
        } catch {
          return { name, markdown: "" };
        }
      }),
    );
  } catch {
    return "(none)";
  }
  const rendered = entries
    .filter((entry) => entry.markdown.trim())
    .map((entry) => `--- ${entry.name} ---\n${entry.markdown.trim()}`)
    .join("\n\n");
  return rendered || "(none)";
}

async function buildReviewPrompt(params: {
  workspaceDir: string;
  messages: unknown[];
}): Promise<string> {
  const skills = await readExistingSkills(params.workspaceDir);
  const transcript = buildTranscript(params.messages);
  return [
    "Review transcript for durable skill updates.",
    "Return JSON only. No markdown unless inside JSON strings.",
    "Use none unless there is a reusable workflow, correction, hard-won fix, or stale skill repair.",
    "Prefer append/replace for existing skills. Create only when no fitting skill exists.",
    "Skill text: terse bullets, imperative, no raw transcript, no secrets, no hidden prompt refs.",
    'Schema: {"action":"none"} or {"action":"create|append|replace","skillName":"kebab-name","title":"...","reason":"...","description":"...","section":"Workflow","body":"...","oldText":"...","newText":"..."}',
    "",
    "Existing skills:",
    skills,
    "",
    "Transcript:",
    transcript,
  ].join("\n");
}

export async function reviewTranscriptForProposal(params: {
  api: OpenClawPluginApi;
  config: SkillWorkshopConfig;
  ctx: ReviewContext;
  messages: unknown[];
}): Promise<SkillProposal | undefined> {
  const prompt = await buildReviewPrompt({
    workspaceDir: params.ctx.workspaceDir,
    messages: params.messages,
  });
  const sessionId = `skill-workshop-review-${randomUUID()}`;
  const stateDir = params.api.runtime.state.resolveStateDir();
  const fallbackModel = resolveReviewerFallbackModel({
    api: params.api,
    agentId: params.ctx.agentId,
  });
  const result = await params.api.runtime.agent.runEmbeddedPiAgent({
    sessionId,
    sessionKey: params.ctx.sessionKey,
    agentId: params.ctx.agentId,
    messageProvider: params.ctx.messageProvider,
    messageChannel: params.ctx.channelId,
    sessionFile: path.join(stateDir, "skill-workshop", `${sessionId}.json`),
    workspaceDir: params.ctx.workspaceDir,
    agentDir: params.api.runtime.agent.resolveAgentDir(params.api.config, params.ctx.agentId),
    config: params.api.config,
    prompt,
    provider: params.ctx.modelProviderId ?? fallbackModel.provider,
    model: params.ctx.modelId ?? fallbackModel.model,
    timeoutMs: params.config.reviewTimeoutMs,
    runId: sessionId,
    trigger: "manual",
    toolsAllow: [],
    disableTools: true,
    disableMessageTool: true,
    bootstrapContextMode: "lightweight",
    verboseLevel: "off",
    reasoningLevel: "off",
    silentExpected: true,
  });
  const rawReply = (result.payloads ?? [])
    .map((payload) => payload.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
  const parsed = parseReviewerJson(rawReply);
  if (!parsed) {
    return undefined;
  }
  return proposalFromReviewerJson({
    parsed,
    workspaceDir: params.ctx.workspaceDir,
    agentId: params.ctx.agentId,
    sessionId: params.ctx.sessionId,
  });
}
