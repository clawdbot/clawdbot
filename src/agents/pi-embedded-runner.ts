import fs from "node:fs/promises";
import os from "node:os";

import type {
  AgentMessage,
  AgentTool,
  ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import {
  buildSystemPrompt,
  createAgentSession,
  createEventBus,
  discoverAuthStorage,
  discoverExtensions,
  discoverModels,
  type ExtensionFactory,
  type LoadedExtension,
  SessionManager,
  SettingsManager,
  type Skill,
} from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import { resolveHeartbeatPrompt } from "../auto-reply/heartbeat.js";
import type {
  ReasoningLevel,
  ThinkLevel,
  VerboseLevel,
} from "../auto-reply/thinking.js";
import { formatToolAggregate } from "../auto-reply/tool-meta.js";
import type { ClawdbotConfig } from "../config/config.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { createSubsystemLogger } from "../logging.js";
import { splitMediaFromOutput } from "../media/parse.js";
import {
  type enqueueCommand,
  enqueueCommandInLane,
} from "../process/command-queue.js";
import { resolveUserPath } from "../utils.js";
import { resolveClawdbotAgentDir } from "./agent-paths.js";
import {
  markAuthProfileCooldown,
  markAuthProfileGood,
  markAuthProfileUsed,
} from "./auth-profiles.js";
import type { BashElevatedDefaults } from "./bash-tools.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  ensureAuthProfileStore,
  getApiKeyForModel,
  resolveAuthProfileOrder,
} from "./model-auth.js";
import { ensureClawdbotModelsJson } from "./models-config.js";
import {
  createObservationMaskingExtension,
  resolveObservationMaskingOptions,
} from "./observation-masking.js";
import {
  buildBootstrapContextFiles,
  ensureSessionHeader,
  formatAssistantErrorText,
  isAuthAssistantError,
  isAuthErrorMessage,
  isRateLimitAssistantError,
  isRateLimitErrorMessage,
  pickFallbackThinkingLevel,
  sanitizeSessionMessagesImages,
} from "./pi-embedded-helpers.js";
import {
  type BlockReplyChunking,
  subscribeEmbeddedPiSession,
} from "./pi-embedded-subscribe.js";
import {
  extractAssistantText,
  extractAssistantThinking,
  formatReasoningMarkdown,
} from "./pi-embedded-utils.js";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";
import { createClawdbotCodingTools } from "./pi-tools.js";
import { resolveSandboxContext } from "./sandbox.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  buildWorkspaceSkillSnapshot,
  loadWorkspaceSkillEntries,
  type SkillEntry,
  type SkillSnapshot,
} from "./skills.js";
import { buildAgentSystemPromptAppend } from "./system-prompt.js";
import { normalizeUsage, type UsageLike } from "./usage.js";
import { loadWorkspaceBootstrapFiles } from "./workspace.js";

export type EmbeddedPiAgentMeta = {
  sessionId: string;
  provider: string;
  model: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

export type EmbeddedPiRunMeta = {
  durationMs: number;
  agentMeta?: EmbeddedPiAgentMeta;
  aborted?: boolean;
};

function buildModelAliasLines(cfg?: ClawdbotConfig) {
  const models = cfg?.agent?.models ?? {};
  const entries: Array<{ alias: string; model: string }> = [];
  for (const [keyRaw, entryRaw] of Object.entries(models)) {
    const model = String(keyRaw ?? "").trim();
    if (!model) continue;
    const alias = String(
      (entryRaw as { alias?: string } | undefined)?.alias ?? "",
    ).trim();
    if (!alias) continue;
    entries.push({ alias, model });
  }
  return entries
    .sort((a, b) => a.alias.localeCompare(b.alias))
    .map((entry) => `- ${entry.alias}: ${entry.model}`);
}

type ApiKeyInfo = {
  apiKey: string;
  profileId?: string;
  source: string;
};

export type EmbeddedPiRunResult = {
  payloads?: Array<{
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    replyToId?: string;
    isError?: boolean;
  }>;
  meta: EmbeddedPiRunMeta;
};

export type EmbeddedPiCompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: unknown;
  };
};

type EmbeddedPiQueueHandle = {
  queueMessage: (text: string) => Promise<void>;
  isStreaming: () => boolean;
  isCompacting: () => boolean;
  abort: () => void;
};

const log = createSubsystemLogger("agent/embedded");

const ACTIVE_EMBEDDED_RUNS = new Map<string, EmbeddedPiQueueHandle>();
type EmbeddedRunWaiter = {
  resolve: (ended: boolean) => void;
  timer: NodeJS.Timeout;
};
const EMBEDDED_RUN_WAITERS = new Map<string, Set<EmbeddedRunWaiter>>();

const isAbortError = (err: unknown): boolean => {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err ? String(err.name) : "";
  if (name === "AbortError") return true;
  const message =
    "message" in err && typeof err.message === "string"
      ? err.message.toLowerCase()
      : "";
  return message.includes("aborted");
};

type EmbeddedSandboxInfo = {
  enabled: boolean;
  workspaceDir?: string;
  workspaceAccess?: "none" | "ro" | "rw";
  agentWorkspaceMount?: string;
  browserControlUrl?: string;
  browserNoVncUrl?: string;
};

function resolveSessionLane(key: string) {
  const cleaned = key.trim() || "main";
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

function resolveGlobalLane(lane?: string) {
  const cleaned = lane?.trim();
  return cleaned ? cleaned : "main";
}

function resolveUserTimezone(configured?: string): string {
  const trimmed = configured?.trim();
  if (trimmed) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(
        new Date(),
      );
      return trimmed;
    } catch {
      // ignore invalid timezone
    }
  }
  const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return host?.trim() || "UTC";
}

function formatUserTime(date: Date, timeZone: string): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") map[part.type] = part.value;
    }
    if (
      !map.weekday ||
      !map.year ||
      !map.month ||
      !map.day ||
      !map.hour ||
      !map.minute
    ) {
      return undefined;
    }
    return `${map.weekday} ${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`;
  } catch {
    return undefined;
  }
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    const serialized = JSON.stringify(error);
    return serialized ?? "Unknown error";
  } catch {
    return "Unknown error";
  }
}

export function buildEmbeddedSandboxInfo(
  sandbox?: Awaited<ReturnType<typeof resolveSandboxContext>>,
): EmbeddedSandboxInfo | undefined {
  if (!sandbox?.enabled) return undefined;
  return {
    enabled: true,
    workspaceDir: sandbox.workspaceDir,
    workspaceAccess: sandbox.workspaceAccess,
    agentWorkspaceMount:
      sandbox.workspaceAccess === "ro" ? "/agent" : undefined,
    browserControlUrl: sandbox.browser?.controlUrl,
    browserNoVncUrl: sandbox.browser?.noVncUrl,
  };
}

const BUILT_IN_TOOL_NAMES = new Set(["read", "bash", "edit", "write"]);

type AnyAgentTool = AgentTool<TSchema, unknown>;

export function splitSdkTools(options: {
  tools: AnyAgentTool[];
  sandboxEnabled: boolean;
}): {
  builtInTools: AnyAgentTool[];
  customTools: ReturnType<typeof toToolDefinitions>;
} {
  // SDK rebuilds built-ins from cwd; route sandboxed versions as custom tools.
  const { tools, sandboxEnabled } = options;
  if (sandboxEnabled) {
    return {
      builtInTools: [],
      customTools: toToolDefinitions(tools),
    };
  }
  return {
    builtInTools: tools.filter((tool) => BUILT_IN_TOOL_NAMES.has(tool.name)),
    customTools: toToolDefinitions(
      tools.filter((tool) => !BUILT_IN_TOOL_NAMES.has(tool.name)),
    ),
  };
}

export function queueEmbeddedPiMessage(
  sessionId: string,
  text: string,
): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) return false;
  if (!handle.isStreaming()) return false;
  if (handle.isCompacting()) return false;
  void handle.queueMessage(text);
  return true;
}

export function abortEmbeddedPiRun(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) return false;
  handle.abort();
  return true;
}

export function isEmbeddedPiRunActive(sessionId: string): boolean {
  return ACTIVE_EMBEDDED_RUNS.has(sessionId);
}

export function isEmbeddedPiRunStreaming(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) return false;
  return handle.isStreaming();
}

export function waitForEmbeddedPiRunEnd(
  sessionId: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  if (!sessionId || !ACTIVE_EMBEDDED_RUNS.has(sessionId))
    return Promise.resolve(true);
  return new Promise((resolve) => {
    const waiters = EMBEDDED_RUN_WAITERS.get(sessionId) ?? new Set();
    const waiter: EmbeddedRunWaiter = {
      resolve,
      timer: setTimeout(
        () => {
          waiters.delete(waiter);
          if (waiters.size === 0) EMBEDDED_RUN_WAITERS.delete(sessionId);
          resolve(false);
        },
        Math.max(100, timeoutMs),
      ),
    };
    waiters.add(waiter);
    EMBEDDED_RUN_WAITERS.set(sessionId, waiters);
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      waiters.delete(waiter);
      if (waiters.size === 0) EMBEDDED_RUN_WAITERS.delete(sessionId);
      clearTimeout(waiter.timer);
      resolve(true);
    }
  });
}

function notifyEmbeddedRunEnded(sessionId: string) {
  const waiters = EMBEDDED_RUN_WAITERS.get(sessionId);
  if (!waiters || waiters.size === 0) return;
  EMBEDDED_RUN_WAITERS.delete(sessionId);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(true);
  }
}

export function resolveEmbeddedSessionLane(key: string) {
  return resolveSessionLane(key);
}

function mapThinkingLevel(level?: ThinkLevel): ThinkingLevel {
  // pi-agent-core supports "xhigh" too; Clawdbot doesn't surface it for now.
  if (!level) return "off";
  return level;
}

function resolveModel(
  provider: string,
  modelId: string,
  agentDir?: string,
): {
  model?: Model<Api>;
  error?: string;
  authStorage: ReturnType<typeof discoverAuthStorage>;
  modelRegistry: ReturnType<typeof discoverModels>;
} {
  const resolvedAgentDir = agentDir ?? resolveClawdbotAgentDir();
  const authStorage = discoverAuthStorage(resolvedAgentDir);
  const modelRegistry = discoverModels(authStorage, resolvedAgentDir);
  const model = modelRegistry.find(provider, modelId) as Model<Api> | null;
  if (!model) {
    return {
      error: `Unknown model: ${provider}/${modelId}`,
      authStorage,
      modelRegistry,
    };
  }
  return { model, authStorage, modelRegistry };
}

function resolvePromptSkills(
  snapshot: SkillSnapshot,
  entries: SkillEntry[],
): Skill[] {
  if (snapshot.resolvedSkills?.length) {
    return snapshot.resolvedSkills;
  }

  const snapshotNames = snapshot.skills.map((entry) => entry.name);
  if (snapshotNames.length === 0) return [];

  const entryByName = new Map(
    entries.map((entry) => [entry.skill.name, entry.skill]),
  );
  return snapshotNames
    .map((name) => entryByName.get(name))
    .filter((skill): skill is Skill => Boolean(skill));
}

type ObservationMaskingExtensionBundle = {
  eventBus: ReturnType<typeof createEventBus>;
  extensions: ExtensionFactory[];
  preloadedExtensions?: LoadedExtension[];
};

async function buildObservationMaskingExtensionBundle(params: {
  config?: ClawdbotConfig;
  workspaceDir: string;
  agentDir: string;
}): Promise<ObservationMaskingExtensionBundle | null> {
  const options = resolveObservationMaskingOptions(params.config);
  if (!options) return null;

  const eventBus = createEventBus();
  let preloadedExtensions: LoadedExtension[] | undefined;

  try {
    const discovered = await discoverExtensions(
      eventBus,
      params.workspaceDir,
      params.agentDir,
    );
    if (discovered.errors.length > 0) {
      log.warn(
        `observation masking: ${discovered.errors.length} extension(s) failed to load`,
      );
    }
    if (discovered.extensions.length > 0) {
      preloadedExtensions = discovered.extensions;
    }
  } catch (err) {
    log.warn(
      `observation masking: extension discovery failed: ${describeUnknownError(err)}`,
    );
  }

  return {
    eventBus,
    extensions: [createObservationMaskingExtension(options)],
    preloadedExtensions,
  };
}

export async function compactEmbeddedPiSession(params: {
  sessionId: string;
  sessionKey?: string;
  messageProvider?: string;
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  config?: ClawdbotConfig;
  skillsSnapshot?: SkillSnapshot;
  provider?: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  bashElevated?: BashElevatedDefaults;
  customInstructions?: string;
  lane?: string;
  enqueue?: typeof enqueueCommand;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
}): Promise<EmbeddedPiCompactResult> {
  const sessionLane = resolveSessionLane(
    params.sessionKey?.trim() || params.sessionId,
  );
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ??
    ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  return enqueueCommandInLane(sessionLane, () =>
    enqueueGlobal(async () => {
      const resolvedWorkspace = resolveUserPath(params.workspaceDir);
      const prevCwd = process.cwd();

      const provider =
        (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
      const modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
      await ensureClawdbotModelsJson(params.config);
      const agentDir = params.agentDir ?? resolveClawdbotAgentDir();
      const { model, error, authStorage, modelRegistry } = resolveModel(
        provider,
        modelId,
        agentDir,
      );
      if (!model) {
        return {
          ok: false,
          compacted: false,
          reason: error ?? `Unknown model: ${provider}/${modelId}`,
        };
      }
      try {
        const apiKeyInfo = await getApiKeyForModel({
          model,
          cfg: params.config,
        });
        authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
      } catch (err) {
        return {
          ok: false,
          compacted: false,
          reason: describeUnknownError(err),
        };
      }

      await fs.mkdir(resolvedWorkspace, { recursive: true });
      const sandboxSessionKey = params.sessionKey?.trim() || params.sessionId;
      const sandbox = await resolveSandboxContext({
        config: params.config,
        sessionKey: sandboxSessionKey,
        workspaceDir: resolvedWorkspace,
      });
      const effectiveWorkspace = sandbox?.enabled
        ? sandbox.workspaceAccess === "rw"
          ? resolvedWorkspace
          : sandbox.workspaceDir
        : resolvedWorkspace;
      await fs.mkdir(effectiveWorkspace, { recursive: true });
      await ensureSessionHeader({
        sessionFile: params.sessionFile,
        sessionId: params.sessionId,
        cwd: effectiveWorkspace,
      });

      let restoreSkillEnv: (() => void) | undefined;
      process.chdir(effectiveWorkspace);
      try {
        const shouldLoadSkillEntries =
          !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
        const skillEntries = shouldLoadSkillEntries
          ? loadWorkspaceSkillEntries(effectiveWorkspace)
          : [];
        const skillsSnapshot =
          params.skillsSnapshot ??
          buildWorkspaceSkillSnapshot(effectiveWorkspace, {
            config: params.config,
            entries: skillEntries,
          });
        restoreSkillEnv = params.skillsSnapshot
          ? applySkillEnvOverridesFromSnapshot({
              snapshot: params.skillsSnapshot,
              config: params.config,
            })
          : applySkillEnvOverrides({
              skills: skillEntries ?? [],
              config: params.config,
            });

        const bootstrapFiles =
          await loadWorkspaceBootstrapFiles(effectiveWorkspace);
        const contextFiles = buildBootstrapContextFiles(bootstrapFiles);
        const promptSkills = resolvePromptSkills(skillsSnapshot, skillEntries);
        const tools = createClawdbotCodingTools({
          bash: {
            ...params.config?.agent?.bash,
            elevated: params.bashElevated,
          },
          sandbox,
          messageProvider: params.messageProvider,
          sessionKey: params.sessionKey ?? params.sessionId,
          agentDir,
          config: params.config,
        });
        const machineName = await getMachineDisplayName();
        const runtimeInfo = {
          host: machineName,
          os: `${os.type()} ${os.release()}`,
          arch: os.arch(),
          node: process.version,
          model: `${provider}/${modelId}`,
        };
        const sandboxInfo = buildEmbeddedSandboxInfo(sandbox);
        const reasoningTagHint = provider === "ollama";
        const userTimezone = resolveUserTimezone(
          params.config?.agent?.userTimezone,
        );
        const userTime = formatUserTime(new Date(), userTimezone);
        const systemPrompt = buildSystemPrompt({
          appendPrompt: buildAgentSystemPromptAppend({
            workspaceDir: effectiveWorkspace,
            defaultThinkLevel: params.thinkLevel,
            extraSystemPrompt: params.extraSystemPrompt,
            ownerNumbers: params.ownerNumbers,
            reasoningTagHint,
            heartbeatPrompt: resolveHeartbeatPrompt(
              params.config?.agent?.heartbeat?.prompt,
            ),
            runtimeInfo,
            sandboxInfo,
            toolNames: tools.map((tool) => tool.name),
            modelAliasLines: buildModelAliasLines(params.config),
            userTimezone,
            userTime,
          }),
          contextFiles,
          skills: promptSkills,
          cwd: effectiveWorkspace,
          tools,
        });

        const sessionManager = SessionManager.open(params.sessionFile);
        const settingsManager = SettingsManager.create(
          effectiveWorkspace,
          agentDir,
        );

        const { builtInTools, customTools } = splitSdkTools({
          tools,
          sandboxEnabled: !!sandbox?.enabled,
        });
        const observationMasking = await buildObservationMaskingExtensionBundle(
          {
            config: params.config,
            workspaceDir: resolvedWorkspace,
            agentDir,
          },
        );

        const { session } = await createAgentSession({
          cwd: resolvedWorkspace,
          agentDir,
          authStorage,
          modelRegistry,
          model,
          thinkingLevel: mapThinkingLevel(params.thinkLevel),
          systemPrompt,
          tools: builtInTools,
          customTools,
          eventBus: observationMasking?.eventBus,
          preloadedExtensions: observationMasking?.preloadedExtensions,
          extensions: observationMasking?.extensions,
          sessionManager,
          settingsManager,
          skills: promptSkills,
          contextFiles,
        });

        try {
          const prior = await sanitizeSessionMessagesImages(
            session.messages,
            "session:history",
          );
          if (prior.length > 0) {
            session.agent.replaceMessages(prior);
          }
          const result = await session.compact(params.customInstructions);
          return {
            ok: true,
            compacted: true,
            result: {
              summary: result.summary,
              firstKeptEntryId: result.firstKeptEntryId,
              tokensBefore: result.tokensBefore,
              details: result.details,
            },
          };
        } finally {
          session.dispose();
        }
      } catch (err) {
        return {
          ok: false,
          compacted: false,
          reason: describeUnknownError(err),
        };
      } finally {
        restoreSkillEnv?.();
        process.chdir(prevCwd);
      }
    }),
  );
}

export async function runEmbeddedPiAgent(params: {
  sessionId: string;
  sessionKey?: string;
  messageProvider?: string;
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  config?: ClawdbotConfig;
  skillsSnapshot?: SkillSnapshot;
  prompt: string;
  provider?: string;
  model?: string;
  authProfileId?: string;
  thinkLevel?: ThinkLevel;
  verboseLevel?: VerboseLevel;
  reasoningLevel?: ReasoningLevel;
  bashElevated?: BashElevatedDefaults;
  timeoutMs: number;
  runId: string;
  abortSignal?: AbortSignal;
  shouldEmitToolResult?: () => boolean;
  onPartialReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  onBlockReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  blockReplyBreak?: "text_end" | "message_end";
  blockReplyChunking?: BlockReplyChunking;
  onReasoningStream?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  onToolResult?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  onAgentEvent?: (evt: {
    stream: string;
    data: Record<string, unknown>;
  }) => void;
  lane?: string;
  enqueue?: typeof enqueueCommand;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  enforceFinalTag?: boolean;
}): Promise<EmbeddedPiRunResult> {
  const sessionLane = resolveSessionLane(
    params.sessionKey?.trim() || params.sessionId,
  );
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ??
    ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  return enqueueCommandInLane(sessionLane, () =>
    enqueueGlobal(async () => {
      const started = Date.now();
      const resolvedWorkspace = resolveUserPath(params.workspaceDir);
      const prevCwd = process.cwd();

      const provider =
        (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
      const modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
      await ensureClawdbotModelsJson(params.config);
      const agentDir = params.agentDir ?? resolveClawdbotAgentDir();
      const { model, error, authStorage, modelRegistry } = resolveModel(
        provider,
        modelId,
        agentDir,
      );
      if (!model) {
        throw new Error(error ?? `Unknown model: ${provider}/${modelId}`);
      }
      const authStore = ensureAuthProfileStore(agentDir);
      const explicitProfileId = params.authProfileId?.trim();
      const profileOrder = resolveAuthProfileOrder({
        cfg: params.config,
        store: authStore,
        provider,
        preferredProfile: explicitProfileId,
      });
      if (explicitProfileId && !profileOrder.includes(explicitProfileId)) {
        throw new Error(
          `Auth profile "${explicitProfileId}" is not configured for ${provider}.`,
        );
      }
      const profileCandidates =
        profileOrder.length > 0 ? profileOrder : [undefined];
      let profileIndex = 0;
      const initialThinkLevel = params.thinkLevel ?? "off";
      let thinkLevel = initialThinkLevel;
      const attemptedThinking = new Set<ThinkLevel>();
      let apiKeyInfo: ApiKeyInfo | null = null;
      let lastProfileId: string | undefined;

      const resolveApiKeyForCandidate = async (candidate?: string) => {
        return getApiKeyForModel({
          model,
          cfg: params.config,
          profileId: candidate,
          store: authStore,
        });
      };

      const applyApiKeyInfo = async (candidate?: string): Promise<void> => {
        apiKeyInfo = await resolveApiKeyForCandidate(candidate);
        authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
        lastProfileId = apiKeyInfo.profileId;
      };

      const advanceAuthProfile = async (): Promise<boolean> => {
        let nextIndex = profileIndex + 1;
        while (nextIndex < profileCandidates.length) {
          const candidate = profileCandidates[nextIndex];
          try {
            await applyApiKeyInfo(candidate);
            profileIndex = nextIndex;
            thinkLevel = initialThinkLevel;
            attemptedThinking.clear();
            return true;
          } catch (err) {
            if (candidate && candidate === explicitProfileId) throw err;
            nextIndex += 1;
          }
        }
        return false;
      };

      try {
        await applyApiKeyInfo(profileCandidates[profileIndex]);
      } catch (err) {
        if (profileCandidates[profileIndex] === explicitProfileId) throw err;
        const advanced = await advanceAuthProfile();
        if (!advanced) throw err;
      }

      while (true) {
        const thinkingLevel = mapThinkingLevel(thinkLevel);
        attemptedThinking.add(thinkLevel);

        log.debug(
          `embedded run start: runId=${params.runId} sessionId=${params.sessionId} provider=${provider} model=${modelId} thinking=${thinkLevel} messageProvider=${params.messageProvider ?? "unknown"}`,
        );

        await fs.mkdir(resolvedWorkspace, { recursive: true });
        const sandboxSessionKey = params.sessionKey?.trim() || params.sessionId;
        const sandbox = await resolveSandboxContext({
          config: params.config,
          sessionKey: sandboxSessionKey,
          workspaceDir: resolvedWorkspace,
        });
        const effectiveWorkspace = sandbox?.enabled
          ? sandbox.workspaceAccess === "rw"
            ? resolvedWorkspace
            : sandbox.workspaceDir
          : resolvedWorkspace;
        await fs.mkdir(effectiveWorkspace, { recursive: true });
        await ensureSessionHeader({
          sessionFile: params.sessionFile,
          sessionId: params.sessionId,
          cwd: effectiveWorkspace,
        });

        let restoreSkillEnv: (() => void) | undefined;
        process.chdir(effectiveWorkspace);
        try {
          const shouldLoadSkillEntries =
            !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
          const skillEntries = shouldLoadSkillEntries
            ? loadWorkspaceSkillEntries(effectiveWorkspace)
            : [];
          const skillsSnapshot =
            params.skillsSnapshot ??
            buildWorkspaceSkillSnapshot(effectiveWorkspace, {
              config: params.config,
              entries: skillEntries,
            });
          restoreSkillEnv = params.skillsSnapshot
            ? applySkillEnvOverridesFromSnapshot({
                snapshot: params.skillsSnapshot,
                config: params.config,
              })
            : applySkillEnvOverrides({
                skills: skillEntries ?? [],
                config: params.config,
              });

          const bootstrapFiles =
            await loadWorkspaceBootstrapFiles(effectiveWorkspace);
          const contextFiles = buildBootstrapContextFiles(bootstrapFiles);
          const promptSkills = resolvePromptSkills(
            skillsSnapshot,
            skillEntries,
          );
          // Tool schemas must be provider-compatible (OpenAI requires top-level `type: "object"`).
          // `createClawdbotCodingTools()` normalizes schemas so the session can pass them through unchanged.
          const tools = createClawdbotCodingTools({
            bash: {
              ...params.config?.agent?.bash,
              elevated: params.bashElevated,
            },
            sandbox,
            messageProvider: params.messageProvider,
            sessionKey: params.sessionKey ?? params.sessionId,
            agentDir,
            config: params.config,
          });
          const machineName = await getMachineDisplayName();
          const runtimeInfo = {
            host: machineName,
            os: `${os.type()} ${os.release()}`,
            arch: os.arch(),
            node: process.version,
            model: `${provider}/${modelId}`,
          };
          const sandboxInfo = buildEmbeddedSandboxInfo(sandbox);
          const reasoningTagHint = provider === "ollama";
          const userTimezone = resolveUserTimezone(
            params.config?.agent?.userTimezone,
          );
          const userTime = formatUserTime(new Date(), userTimezone);
          const systemPrompt = buildSystemPrompt({
            appendPrompt: buildAgentSystemPromptAppend({
              workspaceDir: effectiveWorkspace,
              defaultThinkLevel: thinkLevel,
              extraSystemPrompt: params.extraSystemPrompt,
              ownerNumbers: params.ownerNumbers,
              reasoningTagHint,
              heartbeatPrompt: resolveHeartbeatPrompt(
                params.config?.agent?.heartbeat?.prompt,
              ),
              runtimeInfo,
              sandboxInfo,
              toolNames: tools.map((tool) => tool.name),
              modelAliasLines: buildModelAliasLines(params.config),
              userTimezone,
              userTime,
            }),
            contextFiles,
            skills: promptSkills,
            cwd: effectiveWorkspace,
            tools,
          });

          const sessionManager = SessionManager.open(params.sessionFile);
          const settingsManager = SettingsManager.create(
            effectiveWorkspace,
            agentDir,
          );

          const { builtInTools, customTools } = splitSdkTools({
            tools,
            sandboxEnabled: !!sandbox?.enabled,
          });
          const observationMasking =
            await buildObservationMaskingExtensionBundle({
              config: params.config,
              workspaceDir: resolvedWorkspace,
              agentDir,
            });

          const { session } = await createAgentSession({
            cwd: resolvedWorkspace,
            agentDir,
            authStorage,
            modelRegistry,
            model,
            thinkingLevel,
            systemPrompt,
            // Built-in tools recognized by pi-coding-agent SDK
            tools: builtInTools,
            // Custom clawdbot tools (browser, canvas, nodes, cron, etc.)
            customTools,
            eventBus: observationMasking?.eventBus,
            preloadedExtensions: observationMasking?.preloadedExtensions,
            extensions: observationMasking?.extensions,
            sessionManager,
            settingsManager,
            skills: promptSkills,
            contextFiles,
          });

          const prior = await sanitizeSessionMessagesImages(
            session.messages,
            "session:history",
          );
          if (prior.length > 0) {
            session.agent.replaceMessages(prior);
          }
          let aborted = Boolean(params.abortSignal?.aborted);
          let timedOut = false;
          const abortRun = (isTimeout = false) => {
            aborted = true;
            if (isTimeout) timedOut = true;
            void session.abort();
          };
          const subscription = subscribeEmbeddedPiSession({
            session,
            runId: params.runId,
            verboseLevel: params.verboseLevel,
            reasoningMode: params.reasoningLevel ?? "off",
            shouldEmitToolResult: params.shouldEmitToolResult,
            onToolResult: params.onToolResult,
            onReasoningStream: params.onReasoningStream,
            onBlockReply: params.onBlockReply,
            blockReplyBreak: params.blockReplyBreak,
            blockReplyChunking: params.blockReplyChunking,
            onPartialReply: params.onPartialReply,
            onAgentEvent: params.onAgentEvent,
            enforceFinalTag: params.enforceFinalTag,
          });
          const {
            assistantTexts,
            toolMetas,
            unsubscribe,
            waitForCompactionRetry,
          } = subscription;

          const queueHandle: EmbeddedPiQueueHandle = {
            queueMessage: async (text: string) => {
              await session.steer(text);
            },
            isStreaming: () => session.isStreaming,
            isCompacting: () => subscription.isCompacting(),
            abort: abortRun,
          };
          ACTIVE_EMBEDDED_RUNS.set(params.sessionId, queueHandle);

          let abortWarnTimer: NodeJS.Timeout | undefined;
          const abortTimer = setTimeout(
            () => {
              log.warn(
                `embedded run timeout: runId=${params.runId} sessionId=${params.sessionId} timeoutMs=${params.timeoutMs}`,
              );
              abortRun(true);
              if (!abortWarnTimer) {
                abortWarnTimer = setTimeout(() => {
                  if (!session.isStreaming) return;
                  log.warn(
                    `embedded run abort still streaming: runId=${params.runId} sessionId=${params.sessionId}`,
                  );
                }, 10_000);
              }
            },
            Math.max(1, params.timeoutMs),
          );

          let messagesSnapshot: AgentMessage[] = [];
          let sessionIdUsed = session.sessionId;
          const onAbort = () => {
            abortRun();
          };
          if (params.abortSignal) {
            if (params.abortSignal.aborted) {
              onAbort();
            } else {
              params.abortSignal.addEventListener("abort", onAbort, {
                once: true,
              });
            }
          }
          let promptError: unknown = null;
          try {
            const promptStartedAt = Date.now();
            log.debug(
              `embedded run prompt start: runId=${params.runId} sessionId=${params.sessionId}`,
            );
            try {
              await session.prompt(params.prompt);
            } catch (err) {
              promptError = err;
            } finally {
              log.debug(
                `embedded run prompt end: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - promptStartedAt}`,
              );
            }
            try {
              await waitForCompactionRetry();
            } catch (err) {
              // Capture AbortError from waitForCompactionRetry to enable fallback/rotation.
              if (isAbortError(err)) {
                if (!promptError) promptError = err;
              } else {
                throw err;
              }
            }
            messagesSnapshot = session.messages.slice();
            sessionIdUsed = session.sessionId;
          } finally {
            clearTimeout(abortTimer);
            if (abortWarnTimer) {
              clearTimeout(abortWarnTimer);
              abortWarnTimer = undefined;
            }
            unsubscribe();
            if (ACTIVE_EMBEDDED_RUNS.get(params.sessionId) === queueHandle) {
              ACTIVE_EMBEDDED_RUNS.delete(params.sessionId);
              notifyEmbeddedRunEnded(params.sessionId);
            }
            session.dispose();
            params.abortSignal?.removeEventListener?.("abort", onAbort);
          }
          if (promptError && !aborted) {
            const errorText = describeUnknownError(promptError);
            if (
              (isAuthErrorMessage(errorText) ||
                isRateLimitErrorMessage(errorText)) &&
              (await advanceAuthProfile())
            ) {
              continue;
            }
            const fallbackThinking = pickFallbackThinkingLevel({
              message: errorText,
              attempted: attemptedThinking,
            });
            if (fallbackThinking) {
              log.warn(
                `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
              );
              thinkLevel = fallbackThinking;
              continue;
            }
            throw promptError;
          }

          const lastAssistant = messagesSnapshot
            .slice()
            .reverse()
            .find((m) => (m as AgentMessage)?.role === "assistant") as
            | AssistantMessage
            | undefined;

          const fallbackThinking = pickFallbackThinkingLevel({
            message: lastAssistant?.errorMessage,
            attempted: attemptedThinking,
          });
          if (fallbackThinking && !aborted) {
            log.warn(
              `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
            );
            thinkLevel = fallbackThinking;
            continue;
          }

          const fallbackConfigured =
            (params.config?.agent?.model?.fallbacks?.length ?? 0) > 0;
          const authFailure = isAuthAssistantError(lastAssistant);
          const rateLimitFailure = isRateLimitAssistantError(lastAssistant);

          // Treat timeout as potential rate limit (Antigravity hangs on rate limit)
          const shouldRotate =
            (!aborted && (authFailure || rateLimitFailure)) || timedOut;

          if (shouldRotate) {
            // Mark current profile for cooldown before rotating
            if (lastProfileId) {
              await markAuthProfileCooldown({
                store: authStore,
                profileId: lastProfileId,
              });
              if (timedOut) {
                log.warn(
                  `Profile ${lastProfileId} timed out (possible rate limit). Trying next account...`,
                );
              }
            }
            const rotated = await advanceAuthProfile();
            if (rotated) {
              continue;
            }
            if (fallbackConfigured) {
              const message =
                lastAssistant?.errorMessage?.trim() ||
                (lastAssistant
                  ? formatAssistantErrorText(lastAssistant)
                  : "") ||
                (timedOut
                  ? "LLM request timed out."
                  : rateLimitFailure
                    ? "LLM request rate limited."
                    : "LLM request unauthorized.");
              throw new Error(message);
            }
          }

          const usage = normalizeUsage(lastAssistant?.usage as UsageLike);
          const agentMeta: EmbeddedPiAgentMeta = {
            sessionId: sessionIdUsed,
            provider: lastAssistant?.provider ?? provider,
            model: lastAssistant?.model ?? model.id,
            usage,
          };

          const replyItems: Array<{
            text: string;
            media?: string[];
            isError?: boolean;
          }> = [];

          const errorText = lastAssistant
            ? formatAssistantErrorText(lastAssistant)
            : undefined;

          if (errorText) replyItems.push({ text: errorText, isError: true });

          const inlineToolResults =
            params.verboseLevel === "on" &&
            !params.onPartialReply &&
            !params.onToolResult &&
            toolMetas.length > 0;
          if (inlineToolResults) {
            for (const { toolName, meta } of toolMetas) {
              const agg = formatToolAggregate(toolName, meta ? [meta] : []);
              const { text: cleanedText, mediaUrls } =
                splitMediaFromOutput(agg);
              if (cleanedText)
                replyItems.push({ text: cleanedText, media: mediaUrls });
            }
          }

          const fallbackText = lastAssistant
            ? (() => {
                const base = extractAssistantText(lastAssistant);
                if (params.reasoningLevel !== "on") return base;
                const thinking = extractAssistantThinking(lastAssistant);
                const formatted = thinking
                  ? formatReasoningMarkdown(thinking)
                  : "";
                if (!formatted) return base;
                return base ? `${formatted}\n\n${base}` : formatted;
              })()
            : "";
          for (const text of assistantTexts.length
            ? assistantTexts
            : fallbackText
              ? [fallbackText]
              : []) {
            const { text: cleanedText, mediaUrls } = splitMediaFromOutput(text);
            if (!cleanedText && (!mediaUrls || mediaUrls.length === 0))
              continue;
            replyItems.push({ text: cleanedText, media: mediaUrls });
          }

          const payloads = replyItems
            .map((item) => ({
              text: item.text?.trim() ? item.text.trim() : undefined,
              mediaUrls: item.media?.length ? item.media : undefined,
              mediaUrl: item.media?.[0],
              isError: item.isError,
            }))
            .filter(
              (p) =>
                p.text || p.mediaUrl || (p.mediaUrls && p.mediaUrls.length > 0),
            );

          log.debug(
            `embedded run done: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - started} aborted=${aborted}`,
          );
          if (lastProfileId) {
            await markAuthProfileGood({
              store: authStore,
              provider,
              profileId: lastProfileId,
            });
            // Track usage for round-robin rotation
            await markAuthProfileUsed({
              store: authStore,
              profileId: lastProfileId,
            });
          }
          return {
            payloads: payloads.length ? payloads : undefined,
            meta: {
              durationMs: Date.now() - started,
              agentMeta,
              aborted,
            },
          };
        } finally {
          restoreSkillEnv?.();
          process.chdir(prevCwd);
        }
      }
    }),
  );
}
