import path from "node:path";
import { isUnconfiguredConfigSource } from "../cli/fresh-install-config.js";
import { hasResolvedRosterBeforeMigrations } from "../config/agent-roster-provenance.js";
import {
  ConfigMutationConflictError,
  readConfigFileSnapshot,
  resolveConfigSnapshotHash,
  transformConfigFileWithRetry,
  withConfigMutationExclusive,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { resolveUserPath } from "../utils.js";
import { createAgent, validateAgentIdInput, type CreateAgentSuccess } from "./agent-create.js";
import { listAgentEntries } from "./agent-scope-config.js";
import { loadAgentTeamPreset, loadAgentTemplate } from "./agent-templates.js";
import { resolveDefaultAgentWorkspaceDir } from "./workspace-default.js";

type TeamResult =
  | {
      status: "created";
      coordinatorId: string;
      ambientOwnerId: string;
      agents: CreateAgentSuccess[];
      config: OpenClawConfig;
      configHash?: string;
    }
  | { status: "error"; message: string };

/** Create a directed fleet through the same lifecycle owner as individual agents. */
export async function createAgentTeam(
  params: {
    preset?: string;
    coordinator?: string;
    prefix?: string;
    workspaceRoot?: string;
    bootstrapFirstAgent?: boolean;
    expectedConfigHash?: string | null;
    beforePersistentApply?: () => void;
  } = {},
): Promise<TeamResult> {
  const preset = await loadAgentTeamPreset(params.preset);
  const members = [preset.coordinator, ...preset.specialists].map((member, index) => {
    const id = index === 0 ? (params.coordinator ?? member.id) : member.id;
    const validation = validateAgentIdInput(params.prefix ? `${params.prefix}-${id}` : id);
    if (!validation.ok) {
      throw new Error(validation.message);
    }
    return { role: member.role, id: validation.agentId };
  });
  const ids = members.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    return {
      status: "error",
      message:
        "Team member ids must be distinct after applying the coordinator and prefix options.",
    };
  }
  // Resolve every role and delegation reference before any agent becomes visible.
  const templates = await Promise.all(members.map(({ role }) => loadAgentTemplate(role)));
  const idsByRole = new Map<string, string>(members.map(({ role, id }) => [role, id]));
  const resolvedTargets = templates.map(({ manifest }) =>
    manifest.subagents?.allowAgents?.map((ref) => {
      const target = idsByRole.get(ref) ?? (ids.includes(ref) ? ref : undefined);
      if (!target) {
        throw new Error(`Role "${manifest.role}" refers to unknown team member "${ref}".`);
      }
      return target;
    }),
  );
  const coordinatorId = ids[0]!;

  return await withConfigMutationExclusive(async (lockedConfig) => {
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      return { status: "error", message: "Cannot create a team from an invalid OpenClaw config." };
    }
    if (
      Object.hasOwn(params, "expectedConfigHash") &&
      (resolveConfigSnapshotHash(snapshot) ?? null) !== params.expectedConfigHash
    ) {
      throw new ConfigMutationConflictError("config changed before team creation", {
        retryable: false,
      });
    }
    const authoredRoster = hasResolvedRosterBeforeMigrations(snapshot);
    if (params.bootstrapFirstAgent && authoredRoster) {
      return {
        status: "error",
        message: "Cannot create the first team: an agent roster already exists.",
      };
    }
    const bootstrapFirstAgent =
      !authoredRoster &&
      (params.bootstrapFirstAgent === true ||
        !snapshot.exists ||
        isUnconfiguredConfigSource(snapshot.sourceConfigBeforeMigrations ?? lockedConfig));
    // An established implicit main is still an agent; only first-agent setup replaces it.
    const existingIds = new Set(
      bootstrapFirstAgent
        ? []
        : listAgentEntries(lockedConfig).map(({ id }) => normalizeAgentId(id)),
    );
    const collisions = ids.filter((id) => existingIds.has(id));
    if (collisions.length) {
      return {
        status: "error",
        message: `Agents already exist: ${collisions.join(", ")}. Choose another coordinator or --prefix.`,
      };
    }
    const pending = ids.filter((id) => {
      const deletion = readAgentDeletionJournal(id);
      return deletion && !deletion.cleanupCompleted;
    });
    if (pending.length) {
      return {
        status: "error",
        message: `Agent deletion cleanup is pending: ${pending.join(", ")}.`,
      };
    }
    const workspaceRoot = resolveUserPath(
      params.workspaceRoot?.trim() ||
        lockedConfig.agents?.defaults?.workspace ||
        resolveDefaultAgentWorkspaceDir(),
    );
    const existingAmbientOwnerId = lockedConfig.agents?.defaults?.systemAgent?.agentId?.trim();
    const ambientOwnerId = existingAmbientOwnerId || coordinatorId;
    const agents: CreateAgentSuccess[] = [];
    let config = lockedConfig;
    let configHash: string | undefined;
    for (const [index, member] of members.entries()) {
      const created = await createAgent({
        role: member.role,
        entry: {
          id: member.id,
          workspace: path.join(workspaceRoot, member.id),
          subagents:
            index === 0
              ? { allowAgents: resolvedTargets[index] ?? ids.slice(1), delegationMode: "prefer" }
              : { allowAgents: [] },
        },
        bootstrapFirstAgent: index === 0 && bootstrapFirstAgent,
        ...(index === 0 && Object.hasOwn(params, "expectedConfigHash")
          ? { expectedConfigHash: params.expectedConfigHash }
          : {}),
        beforePersistentApply: params.beforePersistentApply,
      });
      if (created.status === "error") {
        return {
          status: "error",
          message: `${created.message}${agents.length ? ` Created agents retained: ${agents.map(({ agentId }) => agentId).join(", ")}.` : ""}`,
        };
      }
      const { config: createdConfig, ...summary } = created;
      config = createdConfig;
      configHash = created.configHash;
      agents.push(summary);
    }
    if (!existingAmbientOwnerId) {
      const committed = await transformConfigFileWithRetry({
        maxAttempts: 1,
        writeOptions: params.beforePersistentApply
          ? { assertConfigPathForWrite: params.beforePersistentApply }
          : undefined,
        transform: (currentConfig) => ({
          nextConfig: {
            ...currentConfig,
            agents: {
              ...currentConfig.agents,
              defaults: {
                ...currentConfig.agents?.defaults,
                systemAgent: {
                  ...currentConfig.agents?.defaults?.systemAgent,
                  agentId: coordinatorId,
                },
              },
            },
          },
        }),
      });
      config = committed.nextConfig;
      configHash = committed.persistedHash ?? undefined;
    }
    return {
      status: "created",
      coordinatorId,
      ambientOwnerId,
      agents,
      config,
      ...(configHash ? { configHash } : {}),
    };
  });
}
