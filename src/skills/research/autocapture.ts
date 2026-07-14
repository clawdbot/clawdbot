// Research autocapture helpers coordinate replay-safe capture and suggestion state.
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  claimSessionSkillCaptureSignals,
  readSessionSkillCaptureSignalHashes,
  recordSessionSkillCaptureSignals,
  recordSessionSkillSuggestion,
  releaseSessionSkillCaptureSignals,
} from "../../config/sessions/skill-suggestions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readWorkspaceSkillFile } from "../lifecycle/workspace-skill-write.js";
import { resolveSkillWorkshopConfig } from "../workshop/config.js";
import { stripProposalFrontmatterForSkill } from "../workshop/frontmatter.js";
import {
  inspectSkillProposal,
  listSkillProposals,
  listWritableWorkspaceSkillSummaries,
  proposeCreateSkill,
  proposeUpdateSkill,
  reviseSkillProposal,
} from "../workshop/service.js";
import { resolveSkillProposalTarget } from "../workshop/store.js";
import {
  type DurableInstruction,
  extractDurableInstructions,
  groupDurableInstructionProposals,
} from "./signals.js";
import { compactWhitespace } from "./text.js";

type SkillResearchAgentEndEvent = {
  messages: unknown[];
  success?: boolean;
};

type SkillResearchAgentContext = {
  agentId?: string;
  runId?: string;
  sessionKey?: string;
  trigger?: string;
  workspaceDir?: string;
};

const log = createSubsystemLogger("skills/research");
const AUTO_CAPTURE_BLOCKED_TRIGGERS = new Set(["cron", "heartbeat", "memory", "overflow"]);
const AUTO_CAPTURE_BLOCKED_SESSION_SEGMENTS = new Set([
  "cron",
  "hook",
  "subagent",
  "skill-workshop-review",
]);
const TOOL_CALL_BLOCK_TYPES = new Set(["toolCall", "tool_use", "function_call"]);
const SKILL_WORKSHOP_MUTATING_ACTIONS = new Set(["create", "update", "revise"]);
const skillCaptureQueue = new KeyedAsyncQueue();

// Captured updates append below existing skill text so learned context stays auditable.
function buildAutoCaptureUpdateContent(existingSkill: string, capturedContent: string): string {
  return [existingSkill.trimEnd(), "", "## Captured Update", "", capturedContent.trim(), ""].join(
    "\n",
  );
}

function isSkillResearchAutoCaptureEligible(ctx: SkillResearchAgentContext): boolean {
  const trigger = ctx.trigger?.trim().toLowerCase();
  if (trigger && AUTO_CAPTURE_BLOCKED_TRIGGERS.has(trigger)) {
    return false;
  }

  const sessionKey = ctx.sessionKey?.trim().toLowerCase();
  if (!sessionKey) {
    return true;
  }
  if (sessionKey.includes("active-memory")) {
    return false;
  }
  return !sessionKey
    .split(":")
    .some((segment) => AUTO_CAPTURE_BLOCKED_SESSION_SEGMENTS.has(segment));
}

function readToolCallAction(value: unknown): string | undefined {
  let input = value;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const action = (input as { action?: unknown }).action;
  return typeof action === "string" ? action.trim().toLowerCase() : undefined;
}

function isSkillWorkshopMutationBlock(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const block = value as {
    type?: unknown;
    name?: unknown;
    arguments?: unknown;
    input?: unknown;
    args?: unknown;
  };
  if (!TOOL_CALL_BLOCK_TYPES.has(String(block.type))) {
    return false;
  }
  if (typeof block.name !== "string" || block.name.trim().toLowerCase() !== "skill_workshop") {
    return false;
  }
  const action = readToolCallAction(block.arguments ?? block.input ?? block.args);
  return action ? SKILL_WORKSHOP_MUTATING_ACTIONS.has(action) : false;
}

function hasUnfailedSkillWorkshopMutationCall(messages: readonly unknown[]): boolean {
  const callIds = new Set<string>();
  let hasUnidentifiedCall = false;
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    const blocks = Array.isArray(content) ? content : [content];
    for (const block of blocks) {
      if (!isSkillWorkshopMutationBlock(block)) {
        continue;
      }
      const id =
        block && typeof block === "object" && !Array.isArray(block)
          ? (block as { id?: unknown }).id
          : undefined;
      if (typeof id === "string" && id) {
        callIds.add(id);
      } else {
        hasUnidentifiedCall = true;
      }
    }
  }
  if (hasUnidentifiedCall) {
    return true;
  }
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const result = message as { role?: unknown; toolCallId?: unknown; isError?: unknown };
    if (
      result.role === "toolResult" &&
      result.isError === true &&
      typeof result.toolCallId === "string"
    ) {
      callIds.delete(result.toolCallId);
    }
  }
  return callIds.size > 0;
}

function currentTurnMessages(messages: readonly unknown[]): readonly unknown[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      (message as { role?: unknown }).role === "user"
    ) {
      return messages.slice(index);
    }
  }
  return messages;
}

function fingerprintInstructions(instructions: readonly string[]): string {
  const normalized = instructions
    .map((instruction) => compactWhitespace(instruction).toLowerCase())
    .join("\n");
  return sha256Hex(normalized);
}

function proposalSignalHashes(proposal: DurableInstruction): string[] {
  return [
    ...new Set([
      ...proposal.instructions.map((instruction) => fingerprintInstructions([instruction])),
      fingerprintInstructions(proposal.instructions),
    ]),
  ];
}

function instructionSignalHashes(instructions: readonly string[]): string[] {
  return [...new Set(instructions.map((instruction) => fingerprintInstructions([instruction])))];
}

function buildProposalOrigin(ctx: SkillResearchAgentContext) {
  return {
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
    ...(ctx.runId ? { runId: ctx.runId } : {}),
  };
}

/**
 * Captures or suggests durable skill research signals from a completed session turn.
 *
 * Runs regardless of the turn's success flag: the extracted signals are the user's own words,
 * which stay valid when a run fails — corrections given in a failed or timed-out turn are the
 * ones most worth keeping.
 */
export async function runSkillResearchAutoCapture(params: {
  event: SkillResearchAgentEndEvent;
  ctx: SkillResearchAgentContext;
  config?: OpenClawConfig;
}): Promise<void> {
  const workshopConfig = resolveSkillWorkshopConfig(params.config);
  const workspaceDir = params.ctx.workspaceDir;
  if (!workspaceDir) {
    return;
  }
  if (!isSkillResearchAutoCaptureEligible(params.ctx)) {
    return;
  }
  const sessionKey = params.ctx.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  const sessionScope = {
    agentId: params.ctx.agentId,
    sessionKey,
    storePath: resolveStorePath(params.config?.session?.store, {
      agentId: params.ctx.agentId,
    }),
  };
  // Proposals are workspace-scoped, so different sessions must not inspect and revise the same
  // pending draft concurrently from stale content.
  await skillCaptureQueue.enqueue(workspaceDir, async () => {
    const turnMessages = currentTurnMessages(params.event.messages);
    if (hasUnfailedSkillWorkshopMutationCall(turnMessages)) {
      const signalHashes = extractDurableInstructions([...turnMessages]).map((instruction) =>
        fingerprintInstructions([instruction]),
      );
      await recordSessionSkillCaptureSignals({ ...sessionScope, signalHashes });
      return;
    }

    const capturedSignalHashes = readSessionSkillCaptureSignalHashes(sessionScope);
    if (!capturedSignalHashes) {
      return;
    }
    const capturedSignals = new Set(capturedSignalHashes);
    const instructions = extractDurableInstructions(params.event.messages).filter(
      (instruction) => !capturedSignals.has(fingerprintInstructions([instruction])),
    );
    if (instructions.length === 0) {
      return;
    }

    // Discovery runs only after cheap signal extraction, and uses the same writable status as
    // proposeUpdateSkill (including .agents/skills project skills).
    const existingSkills = listWritableWorkspaceSkillSummaries(workspaceDir, {
      config: params.config,
      agentId: params.ctx.agentId,
    });
    const proposals = groupDurableInstructionProposals({
      instructions,
      existingSkills,
    });
    if (proposals.length === 0) {
      return;
    }

    const manifest = await listSkillProposals({ workspaceDir });
    const allInstructionSignalHashes = instructionSignalHashes(instructions);
    if (!workshopConfig.autonomous.enabled) {
      const proposal = proposals.at(-1);
      if (!proposal) {
        return;
      }
      const signalHashes = proposalSignalHashes(proposal);
      const signalHash = signalHashes.at(-1);
      if (!signalHash || capturedSignals.has(signalHash)) {
        return;
      }
      if (
        manifest.proposals.some(
          (entry) =>
            (entry.status === "pending" || entry.status === "quarantined") &&
            entry.skillKey === proposal.skillName,
        )
      ) {
        await recordSessionSkillCaptureSignals({
          ...sessionScope,
          signalHashes: [...allInstructionSignalHashes, ...signalHashes],
        });
        return;
      }
      try {
        if (!proposal.existingSkill) {
          const target = resolveSkillProposalTarget({
            workspaceDir,
            skillName: proposal.skillName,
          });
          if ((await readWorkspaceSkillFile(target.skillFile)) !== null) {
            await recordSessionSkillCaptureSignals({
              ...sessionScope,
              signalHashes: [...allInstructionSignalHashes, ...signalHashes],
            });
            return;
          }
        }
        const recorded = await recordSessionSkillSuggestion({
          ...sessionScope,
          skillName: proposal.skillName,
          signalHash,
          relatedSignalHashes: [...allInstructionSignalHashes, ...signalHashes.slice(0, -1)],
        });
        if (recorded) {
          log.info(`skill research queued suggestion ${proposal.skillName}`);
        }
      } catch (error) {
        log.warn(`skill research suggestion skipped: ${String(error)}`);
      }
      return;
    }

    const selectedInstructionHashes = new Set(
      proposals.flatMap((proposal) => instructionSignalHashes(proposal.instructions)),
    );
    await recordSessionSkillCaptureSignals({
      ...sessionScope,
      signalHashes: allInstructionSignalHashes.filter(
        (hash) => !selectedInstructionHashes.has(hash),
      ),
    });

    for (const proposal of proposals) {
      const signalHashes = proposalSignalHashes(proposal);
      const signalHash = signalHashes.at(-1);
      if (!signalHash || capturedSignals.has(signalHash)) {
        continue;
      }

      const claimedSignalHashes = await claimSessionSkillCaptureSignals({
        ...sessionScope,
        signalHash,
        signalHashes,
      });
      if (!claimedSignalHashes) {
        continue;
      }
      for (const hash of claimedSignalHashes) {
        capturedSignals.add(hash);
      }

      try {
        const sameSkillEntries = manifest.proposals.filter(
          (entry) => entry.skillKey === proposal.skillName,
        );
        if (sameSkillEntries.some((entry) => entry.status === "quarantined")) {
          await recordSessionSkillCaptureSignals({ ...sessionScope, signalHashes });
          continue;
        }
        const pendingEntries = sameSkillEntries.filter((entry) => entry.status === "pending");
        let autocapturePending:
          | NonNullable<Awaited<ReturnType<typeof inspectSkillProposal>>>
          | undefined;
        for (const entry of pendingEntries) {
          const inspected = await inspectSkillProposal(entry.id, { workspaceDir });
          if (inspected?.record.createdBy === "skill-workshop") {
            autocapturePending = inspected;
            break;
          }
        }
        if (pendingEntries.length > 0 && !autocapturePending) {
          await recordSessionSkillCaptureSignals({ ...sessionScope, signalHashes });
          continue;
        }

        // A routed proposal matches a writable skill summary; its filePath is the live SKILL.md.
        // Inferred-topic proposals fall back to the flat layout the workshop uses for creates.
        const matched = existingSkills.find((entry) => entry.name === proposal.skillName);
        const skillFile =
          matched?.filePath ??
          resolveSkillProposalTarget({ workspaceDir, skillName: proposal.skillName }).skillFile;
        const existingSkill = await readWorkspaceSkillFile(skillFile);
        const result = autocapturePending
          ? await reviseSkillProposal({
              workspaceDir,
              config: params.config,
              proposalId: autocapturePending.record.id,
              content: buildAutoCaptureUpdateContent(
                stripProposalFrontmatterForSkill(autocapturePending.content),
                proposal.content,
              ),
              evidence: [autocapturePending.record.evidence, proposal.evidence]
                .filter((value): value is string => Boolean(value))
                .join("\n"),
            })
          : existingSkill === null
            ? await proposeCreateSkill({
                workspaceDir,
                config: params.config,
                name: proposal.skillName,
                description: proposal.description,
                content: proposal.content,
                createdBy: "skill-workshop",
                origin: buildProposalOrigin(params.ctx),
                goal: proposal.goal,
                evidence: proposal.evidence,
              })
            : await proposeUpdateSkill({
                workspaceDir,
                config: params.config,
                agentId: params.ctx.agentId,
                skillName: proposal.skillName,
                description: proposal.description,
                content: buildAutoCaptureUpdateContent(existingSkill, proposal.content),
                createdBy: "skill-workshop",
                origin: buildProposalOrigin(params.ctx),
                goal: proposal.goal,
                evidence: proposal.evidence,
              });
        log.info(
          `skill research auto-capture queued workshop proposal ${result.record.target.skillKey}`,
        );
      } catch (error) {
        await releaseSessionSkillCaptureSignals({
          ...sessionScope,
          signalHashes: claimedSignalHashes,
        });
        for (const hash of claimedSignalHashes) {
          capturedSignals.delete(hash);
        }
        log.warn(`skill research auto-capture skipped ${proposal.skillName}: ${String(error)}`);
      }
    }
  });
}
