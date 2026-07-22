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
import type { OptionalBootstrapFileName } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { FsSafeError, root } from "../infra/fs-safe.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import { resolveUserPath } from "../utils.js";
import { claimCompletedAgentDeletion } from "./agent-lifecycle-registry.js";
import { toAgentEntriesRecord } from "./agent-scope-config.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "./agent-scope.js";
import {
  createAgentIdentityConfig,
  mergeIdentityMarkdownContent,
  sanitizeAgentIdentityLine,
} from "./identity-file.js";
import { DEFAULT_IDENTITY_FILENAME, ensureAgentWorkspace } from "./workspace.js";

const RESERVED_BOOTSTRAP_AGENT_ID = "main";

type CreateAgentResult =
  | {
      status: "created" | "existing";
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
        | "default-conflict"
        | "already-exists"
        | "deletion-pending"
        | "invalid-bindings"
        | "unsafe-identity-file";
      agentId?: string;
      message: string;
    };

type CreateError = Extract<CreateAgentResult, { status: "error" }>;
type AgentEntryConfig = NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>[string];
export type CreateAgentEntry = AgentEntryConfig & { id: string };

type CreateAgentParams = {
  name?: string;
  entry?: CreateAgentEntry;
  workspace?: string;
  model?: string;
  emoji?: unknown;
  avatar?: unknown;
  agentDir?: string;
  skipBootstrap?: boolean;
  skipOptionalBootstrapFiles?: OptionalBootstrapFileName[];
  bindingSpecs?: string[];
  transformConfig?: typeof transformConfigFileWithRetry;
};

class DuplicateAgentError extends Error {}
class DefaultAgentConflictError extends Error {}
class InvalidAgentBindingsError extends Error {}

function createError(
  reason: CreateError["reason"],
  message: string,
  agentId?: string,
): CreateError {
  return { status: "error", reason, message, ...(agentId ? { agentId } : {}) };
}

/** True when raw user input contains a character that can survive agent-id normalization. */
export function hasValidRawAgentIdCharacters(value: string): boolean {
  return /[a-z0-9]/iu.test(value);
}

function isInjectedBootstrapMainEntry(entry: CreateAgentEntry | undefined): boolean {
  return (
    entry?.id === RESERVED_BOOTSTRAP_AGENT_ID &&
    entry.default === true &&
    Object.keys(entry).every((key) => key === "id" || key === "default")
  );
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
  const rawName = (params.entry?.name?.trim() || params.entry?.id || params.name || "").trim();
  if (!rawName) {
    return createError("invalid-name", "agent name is required");
  }
  const rawId = params.entry?.id ?? rawName;
  if (!hasValidRawAgentIdCharacters(rawId)) {
    return createError("invalid-name", `agent name "${rawName}" has no valid id characters`);
  }
  const agentId = normalizeAgentId(rawId);
  const isBootstrapMain = agentId === RESERVED_BOOTSTRAP_AGENT_ID && params.entry?.default === true;
  if (
    (!isBootstrapMain && agentId === RESERVED_BOOTSTRAP_AGENT_ID) ||
    isReservedSystemAgentId(agentId)
  ) {
    return createError("reserved-id", `"${agentId}" is reserved`, agentId);
  }

  const safeName = sanitizeAgentIdentityLine(rawName);
  const model = normalizeOptionalString(params.model);
  const identity = params.entry?.identity ??
    createAgentIdentityConfig({
      name: safeName,
      emoji: params.emoji,
      avatar: params.avatar,
    }) ?? { name: safeName };
  const requestedWorkspace = params.entry?.workspace ?? params.workspace;
  const explicitWorkspace = requestedWorkspace?.trim()
    ? resolveUserPath(requestedWorkspace.trim())
    : undefined;
  const requestedAgentDir = params.entry?.agentDir ?? params.agentDir;
  const explicitAgentDir = requestedAgentDir?.trim()
    ? resolveUserPath(requestedAgentDir.trim())
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
        transform: async (currentConfig, context) => {
          const currentEntries = listAgentEntries(currentConfig);
          const existingIndex = findAgentEntryIndex(currentEntries, agentId);
          const existingEntry = currentEntries[existingIndex];
          const currentDefaults = currentEntries.filter((entry) => entry.default === true);
          const stagedDefaultMatchesCurrent =
            existingEntry?.default === true && currentDefaults.length === 1;
          if (
            params.entry?.default === true &&
            currentEntries.length > 0 &&
            !stagedDefaultMatchesCurrent
          ) {
            throw new DefaultAgentConflictError();
          }
          if (existingIndex >= 0 && !isBootstrapMain) {
            throw new DuplicateAgentError();
          }

          if (
            existingIndex >= 0 &&
            isBootstrapMain &&
            (!isInjectedBootstrapMainEntry(existingEntry) || context.snapshot.exists)
          ) {
            return {
              nextConfig: currentConfig,
              result: {
                status: "existing",
                agentId,
                name: existingEntry?.name ?? safeName,
                workspace: resolveAgentWorkspaceDir(currentConfig, agentId),
                agentDir: resolveAgentDir(currentConfig, agentId),
                bootstrapPending: false,
              },
            };
          }

          const workspaceDir =
            explicitWorkspace ?? resolveAgentWorkspaceDir(currentConfig, agentId);
          const agentDir = explicitAgentDir ?? resolveAgentDir(currentConfig, agentId);
          const materializeInjectedMain =
            existingIndex >= 0 &&
            isBootstrapMain &&
            isInjectedBootstrapMainEntry(existingEntry) &&
            !context.snapshot.exists;
          let nextConfig =
            existingIndex < 0 || materializeInjectedMain
              ? applyAgentConfig(currentConfig, {
                  agentId,
                  name: safeName,
                  workspace: workspaceDir,
                  agentDir,
                  model,
                  identity,
                })
              : currentConfig;
          if (params.entry) {
            const list = listAgentEntries(nextConfig);
            const index = findAgentEntryIndex(list, agentId);
            list[index] = {
              ...list[index],
              ...params.entry,
              id: agentId,
              name: safeName,
              workspace: workspaceDir,
              agentDir,
              identity,
            };
            const { list: _legacyList, ...agentsConfig } = nextConfig.agents ?? {};
            nextConfig = {
              ...nextConfig,
              agents: {
                ...agentsConfig,
                entries: toAgentEntriesRecord(list),
              },
            };
          }
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
            ensureBootstrapFiles:
              params.skipBootstrap === undefined
                ? !nextConfig.agents?.defaults?.skipBootstrap
                : !params.skipBootstrap,
            skipOptionalBootstrapFiles:
              params.skipOptionalBootstrapFiles ??
              nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
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
              status: existingIndex >= 0 ? "existing" : "created",
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
    if (error instanceof DefaultAgentConflictError) {
      return createError(
        "default-conflict",
        `Cannot create agent "${agentId}" with default=true while a roster already exists. Reassign the default separately.`,
        agentId,
      );
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
