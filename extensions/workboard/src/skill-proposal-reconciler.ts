import { listAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi, OpenClawPluginService } from "../api.js";
import {
  captureWorkboardSkillProposalFollowup,
  type WorkboardSkillProposalFollowup,
} from "./skill-proposal-observer.js";
import type { WorkboardStore } from "./store.js";

const SKILL_PROPOSAL_RECONCILE_INTERVAL_MS = 30_000;
const SKILL_PROPOSAL_RECONCILE_TIMEOUT_MS = 30_000;

type SkillProposalReconcilerStore = Pick<WorkboardStore, "create">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`invalid Skill Workshop proposal manifest ${key}`);
  }
  return value;
}

function parsePendingProposals(value: unknown): WorkboardSkillProposalFollowup[] {
  if (!isRecord(value) || !Array.isArray(value.proposals)) {
    throw new Error("invalid Skill Workshop proposal manifest");
  }
  return value.proposals.flatMap((entry) => {
    if (!isRecord(entry)) {
      throw new Error("invalid Skill Workshop proposal manifest entry");
    }
    const status = readRequiredString(entry, "status");
    if (status !== "pending") {
      return [];
    }
    const kind = readRequiredString(entry, "kind");
    if (kind !== "create" && kind !== "update") {
      throw new Error("invalid Skill Workshop proposal manifest kind");
    }
    return [
      {
        id: readRequiredString(entry, "id"),
        kind,
        status,
        skillName: readRequiredString(entry, "skillName"),
      },
    ];
  });
}

export function createWorkboardSkillProposalReconciler(params: {
  api: Pick<OpenClawPluginApi, "runtime">;
  store: SkillProposalReconcilerStore;
}): OpenClawPluginService {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let stopped = true;

  const reconcile = async (ctx: Parameters<OpenClawPluginService["start"]>[0]) => {
    if (running || stopped) {
      return;
    }
    running = true;
    try {
      for (const agentId of listAgentIds(ctx.config)) {
        try {
          if (stopped) {
            return;
          }
          const manifest = await params.api.runtime.gateway.request(
            "skills.proposals.list",
            { agentId },
            {
              timeoutMs: SKILL_PROPOSAL_RECONCILE_TIMEOUT_MS,
              scopes: ["operator.read"],
            },
          );
          for (const proposal of parsePendingProposals(manifest)) {
            if (stopped) {
              return;
            }
            await captureWorkboardSkillProposalFollowup({
              proposal,
              agentId,
              store: params.store,
            });
          }
        } catch (error) {
          const errorKind = error instanceof Error ? error.name : "UnknownError";
          ctx.logger.warn(`workboard: skill proposal reconciliation failed error=${errorKind}`);
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    id: "workboard-skill-proposal-reconciler",
    start(ctx) {
      if (timer) {
        return;
      }
      stopped = false;
      void reconcile(ctx);
      timer = setInterval(() => void reconcile(ctx), SKILL_PROPOSAL_RECONCILE_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
