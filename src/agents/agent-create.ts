import fs from "node:fs/promises";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { applyAgentBindings, parseBindingSpecs } from "../commands/agents.bindings.js";
import {
  applyAgentConfig,
  findAgentEntryIndex,
  listAgentEntries,
} from "../commands/agents.config.js";
import { transformConfigFileWithRetry, withConfigMutationExclusive } from "../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { FsSafeError, root } from "../infra/fs-safe.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import { resolveUserPath } from "../utils.js";
import { claimCompletedAgentDeletion } from "./agent-lifecycle-registry.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "./agent-scope.js";
import {
  createAgentIdentityConfig,
  mergeIdentityMarkdownContent,
  sanitizeAgentIdentityLine,
} from "./identity-file.js";
import { DEFAULT_IDENTITY_FILENAME, ensureAgentWorkspace } from "./workspace.js";

type CreateAgentResult =
  | {
      status: "created";
      agentId: string;
      name: string;
      workspace: string;
      agentDir: string;
      model?: string;
      bootstrapPending: boolean;
      bindingResult?: ReturnType<typeof applyAgentBindings>;
    }
  | {
      status: "error";
      reason:
        | "invalid-name"
        | "reserved-id"
        | "already-exists"
        | "deletion-pending"
        | "invalid-bindings"
        | "unsafe-identity-file";
      agentId?: string;
      message: string;
    };

type CreateError = Extract<CreateAgentResult, { status: "error" }>;

type CreateAgentParams = {
  name: string;
  workspace?: string;
  model?: string;
  emoji?: unknown;
  avatar?: unknown;
  agentDir?: string;
  bindingSpecs?: string[];
  transformConfig?: typeof transformConfigFileWithRetry;
};

class DuplicateAgentError extends Error {}
class InvalidAgentBindingsError extends Error {}

function createError(
  reason: CreateError["reason"],
  message: string,
  agentId?: string,
): CreateError {
  return { status: "error", reason, message, ...(agentId ? { agentId } : {}) };
}

async function writeIdentityFile(params: {
  workspaceDir: string;
  identity: NonNullable<ReturnType<typeof createAgentIdentityConfig>>;
}): Promise<void> {
  const workspaceRoot = await root(params.workspaceDir);
  let existing: string | undefined;
  try {
    const result = await workspaceRoot.read(DEFAULT_IDENTITY_FILENAME, {
      hardlinks: "reject",
      nonBlockingRead: true,
    });
    existing = result.buffer.toString("utf-8");
  } catch (error) {
    if (!(error instanceof FsSafeError && error.code === "not-found")) {
      throw error;
    }
  }
  const content = mergeIdentityMarkdownContent(existing, params.identity);
  await workspaceRoot.write(DEFAULT_IDENTITY_FILENAME, content, { encoding: "utf8" });
}

export async function createAgent(params: CreateAgentParams): Promise<CreateAgentResult> {
  const rawName = params.name.trim();
  if (!rawName) {
    return createError("invalid-name", "agent name is required");
  }
  const agentId = normalizeAgentId(rawName);
  if (agentId === DEFAULT_AGENT_ID || isReservedSystemAgentId(agentId)) {
    return createError("reserved-id", `"${agentId}" is reserved`, agentId);
  }

  const safeName = sanitizeAgentIdentityLine(rawName);
  const model = normalizeOptionalString(params.model);
  const identity = createAgentIdentityConfig({
    name: safeName,
    emoji: params.emoji,
    avatar: params.avatar,
  }) ?? { name: safeName };
  const explicitWorkspace = params.workspace?.trim()
    ? resolveUserPath(params.workspace.trim())
    : undefined;
  const explicitAgentDir = params.agentDir?.trim()
    ? resolveUserPath(params.agentDir.trim())
    : undefined;
  const transformConfig = params.transformConfig ?? transformConfigFileWithRetry;

  try {
    return await withConfigMutationExclusive(async (lockedConfig) => {
      const deletion = readAgentDeletionJournal(agentId);
      if (deletion && !deletion.cleanupCompleted) {
        return createError(
          "deletion-pending",
          `agent "${agentId}" deletion cleanup is still pending`,
          agentId,
        );
      }
      let tombstoneClaimed = false;
      if (
        deletion?.cleanupCompleted &&
        findAgentEntryIndex(listAgentEntries(lockedConfig), agentId) >= 0
      ) {
        if (!claimCompletedAgentDeletion(agentId, deletion.operationId)) {
          throw new Error(`agent "${agentId}" deletion tombstone changed during creation`);
        }
        tombstoneClaimed = true;
      }
      const committed = await transformConfig<CreateAgentResult>({
        afterWrite: { mode: "auto" },
        maxAttempts: 1,
        transform: async (currentConfig) => {
          if (findAgentEntryIndex(listAgentEntries(currentConfig), agentId) >= 0) {
            throw new DuplicateAgentError();
          }

          const workspaceDir =
            explicitWorkspace ?? resolveAgentWorkspaceDir(currentConfig, agentId);
          const agentDir = explicitAgentDir ?? resolveAgentDir(currentConfig, agentId);
          let nextConfig = applyAgentConfig(currentConfig, {
            agentId,
            name: safeName,
            workspace: workspaceDir,
            agentDir,
            model,
            identity,
          });
          const bindingParse = parseBindingSpecs({
            agentId,
            specs: params.bindingSpecs,
            config: nextConfig,
          });
          if (bindingParse.errors.length > 0) {
            throw new InvalidAgentBindingsError(bindingParse.errors.join("\n"));
          }
          const bindingResult = bindingParse.bindings.length
            ? applyAgentBindings(nextConfig, bindingParse.bindings)
            : undefined;
          nextConfig = bindingResult?.config ?? nextConfig;

          // The outer lock makes this result-bearing transform single-attempt: setup
          // finishes before the final entry becomes visible to readers or delete flows.
          const workspace = await ensureAgentWorkspace({
            dir: workspaceDir,
            ensureBootstrapFiles: !nextConfig.agents?.defaults?.skipBootstrap,
            skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
          });
          if (workspace.dir !== workspaceDir) {
            nextConfig = applyAgentConfig(nextConfig, {
              agentId,
              workspace: workspace.dir,
            });
          }
          await fs.mkdir(resolveSessionTranscriptsDirForAgent(agentId), { recursive: true });
          // A creation-time name is config, not proof that the fresh workspace hatched.
          // Keep IDENTITY.md templated until BOOTSTRAP completes its first-turn ceremony.
          if (!workspace.bootstrapPending) {
            await writeIdentityFile({ workspaceDir: workspace.dir, identity });
          }

          return {
            nextConfig,
            result: {
              status: "created",
              agentId,
              name: safeName,
              workspace: workspace.dir,
              agentDir,
              ...(model ? { model } : {}),
              bootstrapPending: workspace.bootstrapPending === true,
              ...(bindingResult ? { bindingResult } : {}),
            },
          };
        },
      });
      if (
        deletion?.cleanupCompleted &&
        !tombstoneClaimed &&
        committed.result?.status === "created" &&
        !claimCompletedAgentDeletion(agentId, deletion.operationId)
      ) {
        throw new Error(`agent "${agentId}" deletion tombstone changed during creation`);
      }
      return committed.result!;
    });
  } catch (error) {
    if (error instanceof DuplicateAgentError) {
      return createError("already-exists", `agent "${agentId}" already exists`, agentId);
    }
    if (error instanceof InvalidAgentBindingsError) {
      return createError("invalid-bindings", error.message, agentId);
    }
    if (error instanceof FsSafeError) {
      return createError(
        "unsafe-identity-file",
        `unsafe workspace file "${DEFAULT_IDENTITY_FILENAME}"`,
        agentId,
      );
    }
    throw error;
  }
}
