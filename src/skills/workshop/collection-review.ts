import { randomUUID } from "node:crypto";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection-config.js";
import { SessionManager } from "../../agents/sessions/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { CommandLane } from "../../process/lanes.js";
import {
  listWritableSkillCollection,
  type SkillCollectionReconcileContext,
  type SkillCollectionReconcileResult,
} from "./collection-reconcile.js";
import { resolveSkillWorkshopConfig } from "./config.js";

const COLLECTION_REVIEW_SESSION_SEGMENT = "skill-collection-review";
const COLLECTION_REVIEW_TIMEOUT_MS = 10 * 60_000;
const COLLECTION_REVIEW_INITIAL_DELAY_MS = 5 * 60_000;
const COLLECTION_REVIEW_INTERVAL_MS = 24 * 60 * 60_000;

export function startSkillCollectionMaintenance(options: {
  onError: (error: unknown) => void;
  run: () => Promise<unknown>;
}): () => void {
  let inFlight: Promise<void> | null = null;
  const performReview = () => {
    if (inFlight) {
      return inFlight;
    }
    inFlight = options
      .run()
      .then(() => undefined)
      .catch(options.onError)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  const initialReview = setTimeout(() => void performReview(), COLLECTION_REVIEW_INITIAL_DELAY_MS);
  const reviewInterval = setInterval(() => void performReview(), COLLECTION_REVIEW_INTERVAL_MS);
  return () => {
    clearTimeout(initialReview);
    clearInterval(reviewInterval);
  };
}

export async function runSkillCollectionReview(params: {
  agentId: string;
  config: OpenClawConfig;
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillCollectionReconcileResult | null> {
  const skills = listWritableSkillCollection(params.workspaceDir, {
    agentId: params.agentId,
    config: params.config,
  });
  if (skills.length === 0) {
    return null;
  }
  const model = resolveDefaultModelForAgent({ cfg: params.config, agentId: params.agentId });
  const sessionId = randomUUID();
  const sessionKey = `agent:${params.agentId}:${COLLECTION_REVIEW_SESSION_SEGMENT}:incognito-${sessionId}`;
  const collectionReconcile: SkillCollectionReconcileContext = {};
  const { runEmbeddedAgent } = await import("../../agents/embedded-agent.js");
  await runEmbeddedAgent({
    sessionId,
    sessionKey,
    sandboxSessionKey: sessionKey,
    sessionManager: SessionManager.inMemory(params.workspaceDir),
    agentId: params.agentId,
    trigger: "cron",
    lane: CommandLane.SkillWorkshopReview,
    agentHarnessId: "openclaw",
    agentHarnessRuntimeOverride: "openclaw",
    workspaceDir: params.workspaceDir,
    config: params.config,
    prompt: buildCollectionReviewPrompt(skills),
    provider: model.provider,
    model: model.model,
    modelSelectionLocked: true,
    modelFallbacksOverride: [],
    timeoutMs: COLLECTION_REVIEW_TIMEOUT_MS,
    runId: `${COLLECTION_REVIEW_SESSION_SEGMENT}:${randomUUID()}`,
    toolsAllow: ["skill_workshop"],
    disableMessageTool: true,
    disableTrajectory: true,
    skillWorkshopCollectionReconcile: collectionReconcile,
    skillWorkshopProposalEnv: params.env,
    cleanupBundleMcpOnRunEnd: true,
    bootstrapContextMode: "lightweight",
    skillsSnapshot: { prompt: "", skills: [] },
    verboseLevel: "off",
    reasoningLevel: "off",
    suppressToolErrorWarnings: true,
  });
  if (!collectionReconcile.result) {
    throw new Error("Skill collection review ended without reconciling the collection.");
  }
  return collectionReconcile.result;
}

export async function runScheduledSkillCollectionReviews(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (resolveSkillWorkshopConfig(params.config).autonomous.mode !== "auto") {
    return;
  }
  await runWithGatewayIndependentRootWorkAdmission(async () => {
    const reviewedWorkspaces = new Set<string>();
    for (const agentId of listAgentIds(params.config)) {
      const workspaceDir = resolveAgentWorkspaceDir(params.config, agentId, params.env);
      if (reviewedWorkspaces.has(workspaceDir)) {
        continue;
      }
      reviewedWorkspaces.add(workspaceDir);
      await runSkillCollectionReview({ ...params, agentId, workspaceDir });
    }
  });
}

function buildCollectionReviewPrompt(
  skills: readonly { name: string; description?: string }[],
): string {
  return [
    "Clean and improve this writable skill collection.",
    "",
    "Read every listed skill with skill_workshop action=read. Then make exactly one action=reconcile call.",
    "Keep a small set of broad, reusable, high-quality skills. Merge duplicate or overlapping procedures. Rewrite weak skills when the knowledge is durable. Drop junk, task artifacts, stale fragments, and skills that are too narrow to route reliably. Preserve distinct useful knowledge. Do not merely report recommendations.",
    "",
    "Current skills:",
    ...skills.map(
      (skill) => `- ${skill.name}${skill.description ? ` — ${skill.description}` : ""}`,
    ),
  ].join("\n");
}
