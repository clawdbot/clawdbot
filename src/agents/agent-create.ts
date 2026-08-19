import fs from "node:fs/promises";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { applyAgentBindings, parseBindingSpecs } from "../commands/agents.bindings.js";
import {
  applyAgentConfig,
  findAgentEntryIndex,
  listAgentEntries,
} from "../commands/agents.config.js";
import { hasResolvedRosterBeforeMigrations } from "../config/agent-roster-provenance.js";
import {
  ConfigMutationConflictError,
  transformConfigFileWithRetry,
  withConfigMutationExclusive,
} from "../config/config.js";
import type { LegacyMainSessionMigrationOutcome } from "../config/sessions/legacy-main-session-migration.contract.js";
import { migrateLegacyMainSessionKeys } from "../config/sessions/legacy-main-session-migration.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import type { OptionalBootstrapFileName } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { FsSafeError, root } from "../infra/fs-safe.js";
import { normalizeAgentId, normalizeAgentIdStrict } from "../routing/session-key.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { recordAgentProvenance, type AgentCreatedVia } from "../state/agent-provenance.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import { resolveUserPath } from "../utils.js";
import { claimCompletedAgentDeletion } from "./agent-lifecycle-registry.js";
import { toAgentEntriesRecord } from "./agent-scope-config.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "./agent-scope.js";
import { resolveSharedAuthStoreOwnership } from "./auth-profiles/path-resolve.js";
import {
  createAgentIdentityConfig,
  mergeIdentityMarkdownContent,
  sanitizeAgentIdentityLine,
} from "./identity-file.js";
import { DEFAULT_IDENTITY_FILENAME, ensureAgentWorkspace } from "./workspace.js";

const BOOTSTRAP_AGENT_ID = "main";

type CreateAgentSuccess = {
  status: "created" | "existing";
  agentId: string;
  name: string;
  workspace: string;
  agentDir: string;
  model?: string;
  bootstrapPending: boolean;
  configHash?: string;
  bindingResult?: ReturnType<typeof applyAgentBindings>;
};

type CreateError = {
  status: "error";
  reason:
    | "invalid-name"
    | "reserved-id"
    | "already-exists"
    | "deletion-pending"
    | "invalid-bindings"
    | "legacy-session-migration-required"
    | "shared-auth-store-owned-by-main"
    | "unsafe-identity-file";
  agentId?: string;
  message: string;
};

type CreateAgentResult = (CreateAgentSuccess & { config: OpenClawConfig }) | CreateError;
type AgentEntryConfig = NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>[string];
type CreateAgentEntry = AgentEntryConfig & { id: string };
type ConfigCommitRollback = () => void | Promise<void>;

type CreateAgentParams = {
  name?: string;
  entry?: CreateAgentEntry;
  /** Internal authorization for onboarding to materialize the sole implicit `main` agent. */
  bootstrapMain?: boolean;
  /** Replace the load-time compatibility roster when onboarding creates the first real agent. */
  bootstrapFirstAgent?: boolean;
  /** Config revision that must still own first-agent creation under the write lock. */
  expectedConfigHash?: string | null;
  /** Full guided-flow staging based on expectedConfigHash; creation still publishes it once. */
  stagedConfig?: OpenClawConfig;
  workspace?: string;
  model?: string;
  emoji?: unknown;
  avatar?: unknown;
  agentDir?: string;
  skipBootstrap?: boolean;
  skipOptionalBootstrapFiles?: OptionalBootstrapFileName[];
  bindingSpecs?: string[];
  transformConfig?: typeof transformConfigFileWithRetry;
  /** Prepare guided staged state at the last reversible edge before config publication. */
  prepareConfigCommit?: () => Promise<ConfigCommitRollback | void>;
  provenance?: { createdVia: AgentCreatedVia; creatorAgentId?: string };
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

export function validateAgentIdInput(
  rawId: string,
  options: { displayName?: string } = {},
):
  | { ok: true; agentId: string }
  | { ok: false; reason: "invalid-name" | "reserved-id"; message: string; agentId?: string } {
  const displayName = options.displayName ?? rawId;
  const normalized = normalizeAgentIdStrict(rawId);
  if (!normalized.ok) {
    return {
      ok: false,
      reason: "invalid-name",
      message: `Agent name "${displayName}" has no valid id characters. Use at least one letter a-z or digit.`,
    };
  }
  const agentId = normalized.value;
  if (isReservedSystemAgentId(agentId)) {
    return { ok: false, reason: "reserved-id", message: `"${agentId}" is reserved`, agentId };
  }
  return { ok: true, agentId };
}

function isInjectedBootstrapMainEntry(entry: CreateAgentEntry | undefined): boolean {
  return entry?.id === BOOTSTRAP_AGENT_ID && Object.keys(entry).every((key) => key === "id");
}

function describeLegacySessionOutcome(outcome: LegacyMainSessionMigrationOutcome): string {
  const claims = (outcome.sourceKeys ?? []).map(
    (key, index) => `${outcome.paths?.[index] ?? outcome.paths?.[0] ?? "session store"}#${key}`,
  );
  switch (outcome.kind) {
    case "divergent-aliases":
    case "divergent-canonical":
      return `${outcome.kind} for ${outcome.canonicalKey ?? "the canonical session"}; preserved claims ${claims.join(", ") || "could not be reconciled"} must be quarantined`;
    case "legacy-json-store":
      return `legacy JSON session store ${outcome.paths?.join(", ") ?? "requires import"}`;
    case "store-unreadable":
      return `unreadable session store ${outcome.paths?.join(", ") ?? "unknown"}${outcome.detail ? ` (${outcome.detail})` : ""}`;
    case "migrated-in-place":
    case "migrated-cross-store":
    case "canonical-exists-identical":
      return `legacy claim ${claims.join(", ") || outcome.canonicalKey || "requires migration"}`;
    case "not-armed":
      return outcome.detail === "owner-unresolved"
        ? "legacy main sessions have no unambiguous configured owner; set agents.defaults.sessionStore.agentId to the intended live owner"
        : `legacy main session migration is not armed (${outcome.detail ?? "unknown reason"})`;
    case "no-legacy-rows":
      return "the current session-store layout has no matching completed migration ledger";
  }
  const unreachable: never = outcome.kind;
  return unreachable;
}

async function evaluateMainCreationGate(
  config: OpenClawConfig,
  agentId: string,
): Promise<CreateError | undefined> {
  const roster = listAgentEntries(config).map((entry) => normalizeAgentId(entry.id));
  if (
    agentId !== BOOTSTRAP_AGENT_ID ||
    roster.includes(BOOTSTRAP_AGENT_ID) ||
    !roster.some((id) => id !== BOOTSTRAP_AGENT_ID)
  ) {
    return undefined;
  }

  const migration = await migrateLegacyMainSessionKeys({
    cfg: config,
    forceScan: true,
    legacyAgentId: BOOTSTRAP_AGENT_ID,
    mode: "detect",
  });
  if (!migration.armed || !migration.ledgerComplete) {
    const details = migration.outcomes.map(describeLegacySessionOutcome).join("; ");
    return createError(
      "legacy-session-migration-required",
      `Cannot create agent "main": ${details}. Run openclaw doctor --fix, then retry.`,
      agentId,
    );
  }

  if (resolveSharedAuthStoreOwnership().location !== "state-db") {
    return createError(
      "shared-auth-store-owned-by-main",
      'Cannot create agent "main" while agents/main/agent owns the shared auth store. Run openclaw doctor --fix to relocate shared auth, then retry.',
      agentId,
    );
  }
  return undefined;
}

/** Read-only early check for guided flows that stage side effects before their final create. */
export async function checkAgentCreationGate(agentId: string): Promise<CreateError | undefined> {
  return await withConfigMutationExclusive(
    async (lockedConfig) => await evaluateMainCreationGate(lockedConfig, normalizeAgentId(agentId)),
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
  if (params.stagedConfig && !Object.hasOwn(params, "expectedConfigHash")) {
    throw new Error("staged agent creation requires an expected config hash");
  }
  const rawName = (params.entry?.name?.trim() || params.entry?.id || params.name || "").trim();
  if (!rawName) {
    return createError("invalid-name", "agent name is required");
  }
  const rawId = params.entry?.id ?? rawName;
  const validation = validateAgentIdInput(rawId, {
    displayName: rawName,
  });
  if (!validation.ok) {
    return createError(validation.reason, validation.message, validation.agentId);
  }
  const agentId = validation.agentId;
  const isBootstrapMain = agentId === BOOTSTRAP_AGENT_ID && params.bootstrapMain === true;

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
  let configCommitRollback: ConfigCommitRollback | undefined;

  try {
    return await withConfigMutationExclusive(async (lockedConfig) => {
      const gateError = await evaluateMainCreationGate(lockedConfig, agentId);
      if (gateError) {
        return gateError;
      }
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
      const committed = await transformConfig<CreateAgentSuccess>({
        afterWrite: { mode: "auto" },
        maxAttempts: 1,
        ...(params.bootstrapFirstAgent
          ? { writeOptions: { allowedAgentRosterRemovals: [BOOTSTRAP_AGENT_ID] } }
          : {}),
        transform: async (currentConfig, context) => {
          if (
            Object.hasOwn(params, "expectedConfigHash") &&
            context.previousHash !== params.expectedConfigHash
          ) {
            throw new ConfigMutationConflictError("config changed before first-agent creation", {
              retryable: false,
            });
          }
          const hasAuthoredRoster =
            params.bootstrapFirstAgent === true &&
            hasResolvedRosterBeforeMigrations(context.snapshot);
          if (params.bootstrapFirstAgent && hasAuthoredRoster) {
            throw new DuplicateAgentError();
          }
          const bootstrappingFirstAgent = params.bootstrapFirstAgent === true;
          const currentEntries = bootstrappingFirstAgent ? [] : listAgentEntries(currentConfig);
          const existingIndex = findAgentEntryIndex(currentEntries, agentId);
          const existingEntry = currentEntries[existingIndex];
          if (
            isBootstrapMain &&
            currentEntries.length > 0 &&
            !currentEntries.some((entry) => normalizeAgentId(entry.id) === BOOTSTRAP_AGENT_ID)
          ) {
            // Never inject implicit bootstrap main into a concurrently authored fleet.
            throw new DuplicateAgentError();
          }
          if (existingIndex >= 0 && !isBootstrapMain) {
            throw new DuplicateAgentError();
          }

          if (
            existingIndex >= 0 &&
            isBootstrapMain &&
            (currentEntries.length !== 1 ||
              !isInjectedBootstrapMainEntry(existingEntry) ||
              context.snapshot.exists)
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
          const creationBase = bootstrappingFirstAgent
            ? {
                ...currentConfig,
                agents: {
                  ...currentConfig.agents,
                  entries: {},
                  list: undefined,
                },
              }
            : (params.stagedConfig ?? currentConfig);
          let nextConfig =
            existingIndex < 0 || materializeInjectedMain
              ? applyAgentConfig(creationBase, {
                  agentId,
                  name: safeName,
                  workspace: workspaceDir,
                  agentDir,
                  model,
                  identity,
                })
              : creationBase;
          if (params.entry) {
            const { default: _retiredDefault, ...stagedEntry } = params.entry;
            const list = listAgentEntries(nextConfig);
            const index = findAgentEntryIndex(list, agentId);
            list[index] = {
              ...list[index],
              ...stagedEntry,
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
            const entries = listAgentEntries(nextConfig);
            const entryIndex = findAgentEntryIndex(entries, agentId);
            const currentEntry = entries[entryIndex];
            if (entryIndex >= 0 && currentEntry) {
              entries[entryIndex] = {
                ...currentEntry,
                id: agentId,
                workspace: workspace.dir,
              };
              const { list: _legacyList, ...agentsConfig } = nextConfig.agents ?? {};
              nextConfig = {
                ...nextConfig,
                agents: { ...agentsConfig, entries: toAgentEntriesRecord(entries) },
              };
            }
          }
          await fs.mkdir(resolveSessionTranscriptsDirForAgent(agentId), { recursive: true });
          // A creation-time name is config, not proof that the fresh workspace hatched.
          // Keep IDENTITY.md templated until BOOTSTRAP completes its first-turn ceremony.
          if (!workspace.bootstrapPending) {
            await writeIdentityFile({ workspaceDir: workspace.dir, identity });
          }
          // The receipt owns compensation until the config transform publishes this result.
          const preparedRollback = await params.prepareConfigCommit?.();
          configCommitRollback =
            typeof preparedRollback === "function" ? preparedRollback : undefined;

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
      // Publication is now irreversible; later tombstone or provenance failures retain staged state.
      configCommitRollback = undefined;
      if (
        deletion?.cleanupCompleted &&
        !tombstoneClaimed &&
        committed.result?.status === "created" &&
        !claimCompletedAgentDeletion(agentId, deletion.operationId)
      ) {
        throw new Error(`agent "${agentId}" deletion tombstone changed during creation`);
      }
      const result = committed.result!;
      if (result.status === "created") {
        recordAgentProvenance(agentId, params.provenance ?? { createdVia: "operator" });
      }
      return {
        ...result,
        config: committed.nextConfig,
        ...(typeof committed.persistedHash === "string"
          ? { configHash: committed.persistedHash }
          : {}),
      };
    });
  } catch (error) {
    if (configCommitRollback) {
      try {
        await configCommitRollback();
      } catch (rollbackError) {
        throw new Error(
          `${String(error)}\nstaged config rollback failed: ${String(rollbackError)}`,
          { cause: rollbackError },
        );
      }
    }
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
