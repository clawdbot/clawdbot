import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { detectMime, normalizeMimeType } from "@openclaw/media-core/mime";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  listProfilesForProvider,
  loadAuthProfileStoreForRuntime,
} from "../../agents/auth-profiles.js";
import { updateAuthProfileStoreWithLock } from "../../agents/auth-profiles/store.js";
import { buildExplicitSessionIdSessionKey } from "../../agents/command/session.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { canonicalizeCaseOnlyCatalogModelRef } from "../../agents/model-selection.js";
import { loadPreparedModelCatalog } from "../../agents/prepared-model-catalog.js";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "../../agents/simple-completion-runtime.js";
import { normalizeThinkLevel, type ThinkLevel } from "../../auto-reply/thinking.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway, randomIdempotencyKey } from "../../gateway/call.js";
import { ADMIN_SCOPE } from "../../gateway/operator-scopes.js";
import { convertHeicToJpeg } from "../../media/media-services.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { getModelsCommandSecretTargetIds } from "../command-secret-targets.js";
import { collectOption } from "../program/helpers.js";
import type { CapabilityEnvelope, CapabilityTransport } from "./metadata.js";
import {
  emitJsonOrText,
  formatEnvelopeForText,
  providerHasGenericConfig,
  providerSummaryText,
  resolveLocalCapabilityRuntimeConfig,
  resolveModelRefOverride,
  resolveSelectedProviderFromModelRef,
  resolveTransport,
} from "./shared.js";

const LOCAL_MODEL_RUN_SYSTEM_PROMPT = "You are a personal assistant running inside OpenClaw.";
const HEIC_MODEL_RUN_MIMES = new Set(["image/heic", "image/heif"]);

async function canonicalizeModelRunRef(params: {
  raw: string | undefined;
  cfg: OpenClawConfig;
  preserveAuthProfile: boolean;
}): Promise<string | undefined> {
  return await canonicalizeCaseOnlyCatalogModelRef({
    cfg: params.cfg,
    raw: params.raw,
    defaultProvider: DEFAULT_PROVIDER,
    loadCatalog: () => loadPreparedModelCatalog({ config: params.cfg, readOnly: true }),
    preserveAuthProfile: params.preserveAuthProfile,
  });
}

function collectModelRunText(content: Array<{ type: string; text?: string }>): string {
  return content
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
}

function requireModelRunPrompt(value: unknown): string {
  if (typeof value !== "string" || normalizeOptionalString(value) === undefined) {
    throw new Error("--prompt cannot be empty or whitespace-only.");
  }
  return value;
}

type ModelRunImageFile = {
  path: string;
  fileName: string;
  mimeType: string;
  data: string;
};

async function readModelRunImageFiles(files: string[] | undefined): Promise<ModelRunImageFile[]> {
  if (!files || files.length === 0) {
    return [];
  }
  return await Promise.all(
    files.map(async (filePath) => {
      const resolvedPath = path.resolve(filePath);
      const buffer = await fs.readFile(resolvedPath);
      const mimeType = normalizeMimeType(
        await detectMime({
          buffer,
          filePath: resolvedPath,
        }),
      );
      if (!mimeType?.startsWith("image/")) {
        throw new Error(
          `Unsupported --file for model run: ${resolvedPath}. Only image files are supported; use infer audio transcribe for audio files.`,
        );
      }
      if (HEIC_MODEL_RUN_MIMES.has(mimeType)) {
        const converted = await convertHeicToJpeg(buffer);
        return {
          path: resolvedPath,
          fileName: path.basename(resolvedPath),
          mimeType: "image/jpeg",
          data: converted.toString("base64"),
        };
      }
      return {
        path: resolvedPath,
        fileName: path.basename(resolvedPath),
        mimeType,
        data: buffer.toString("base64"),
      };
    }),
  );
}

function normalizeModelRunThinking(value: unknown): ThinkLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("--thinking must be a string.");
  }
  const normalized = normalizeThinkLevel(value);
  if (!normalized) {
    throw new Error(
      "Invalid thinking level. Use one of: off, minimal, low, medium, high, adaptive, xhigh, max.",
    );
  }
  return normalized;
}

async function runModelRun(params: {
  prompt: string;
  files?: string[];
  model?: string;
  thinking?: ThinkLevel;
  transport: CapabilityTransport;
}) {
  const cfg =
    params.transport === "local"
      ? await resolveLocalCapabilityRuntimeConfig({
          commandName: "infer model run",
          targetIds: getModelsCommandSecretTargetIds(),
        })
      : getRuntimeConfig();
  const agentId = resolveDefaultAgentId(cfg);
  const modelRef = await canonicalizeModelRunRef({
    raw: params.model,
    cfg,
    preserveAuthProfile: params.transport === "local",
  });
  const explicitModelOverride = resolveModelRefOverride(params.model);
  const hasExplicitProviderModelOverride = Boolean(
    params.model?.trim() && explicitModelOverride.provider && explicitModelOverride.model,
  );
  const imageFiles = await readModelRunImageFiles(params.files);
  const messageContent =
    imageFiles.length > 0
      ? [
          { type: "text" as const, text: params.prompt },
          ...imageFiles.map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ]
      : params.prompt;
  if (params.transport === "local") {
    const prepared = await prepareSimpleCompletionModelForAgent({
      cfg,
      agentId,
      modelRef,
      allowMissingApiKeyModes: ["aws-sdk"],
      ...(hasExplicitProviderModelOverride ? { allowBundledStaticCatalogFallback: true } : {}),
      skipAgentDiscovery: true,
    });
    if ("error" in prepared) {
      throw new Error(prepared.error);
    }
    if (prepared.selection.provider === "codex") {
      throw new Error(
        'The codex provider is served by the Codex app-server agent runtime, not the local simple-completion transport. Use an openai/<model> ref with provider/model agentRuntime.id: "codex", run through the gateway, or use /codex commands.',
      );
    }
    const localModelRunSystemPrompt =
      prepared.model.api === "openai-chatgpt-responses" ? LOCAL_MODEL_RUN_SYSTEM_PROMPT : undefined;
    const result = await completeWithPreparedSimpleCompletionModel({
      model: prepared.model,
      auth: prepared.auth,
      cfg,
      context: {
        ...(localModelRunSystemPrompt ? { systemPrompt: localModelRunSystemPrompt } : {}),
        messages: [
          {
            role: "user",
            content: messageContent,
            timestamp: Date.now(),
          },
        ],
      },
      options: {
        maxTokens:
          typeof prepared.model.maxTokens === "number" && Number.isFinite(prepared.model.maxTokens)
            ? prepared.model.maxTokens
            : undefined,
        ...(params.thinking ? { reasoning: params.thinking } : {}),
      },
    });
    const text = collectModelRunText(result.content);
    if (!text) {
      const providerErrorMessage = (result as { errorMessage?: unknown }).errorMessage;
      const detail =
        typeof providerErrorMessage === "string" && providerErrorMessage.trim()
          ? `: ${providerErrorMessage.trim()}`
          : "";
      throw new Error(
        `No text output returned for provider "${prepared.selection.provider}" model "${prepared.selection.modelId}"${detail}.`,
      );
    }
    return {
      ok: true,
      capability: "model.run",
      transport: "local" as const,
      provider: prepared.selection.provider,
      model: prepared.selection.modelId,
      attempts: [],
      ...(imageFiles.length > 0
        ? {
            inputs: imageFiles.map((image) => ({
              path: image.path,
              mimeType: image.mimeType,
            })),
          }
        : {}),
      outputs: [
        {
          text,
          mediaUrl: null,
        },
      ],
    } satisfies CapabilityEnvelope;
  }

  const { provider, model } = resolveModelRefOverride(modelRef);
  // Provider/model overrides require trusted-operator scope. Use the backend
  // shared-secret lane so local gateway smokes do not depend on paired CLI device scopes.
  const hasModelOverride = Boolean(provider || model);
  const sessionId = `model-run-${randomUUID()}`;
  const sessionKey = buildExplicitSessionIdSessionKey({ agentId, sessionId });
  const response: {
    result?: {
      payloads?: Array<{ text?: string; mediaUrl?: string | null; mediaUrls?: string[] }>;
      meta?: {
        agentMeta?: {
          provider?: string;
          model?: string;
          fallbackAttempts?: Array<Record<string, unknown>>;
        };
      };
    };
  } = await callGateway({
    method: "agent",
    params: {
      agentId,
      sessionId,
      sessionKey,
      message: params.prompt,
      attachments:
        imageFiles.length > 0
          ? imageFiles.map((image) => ({
              type: "image",
              fileName: image.fileName,
              mimeType: image.mimeType,
              content: image.data,
            }))
          : undefined,
      provider,
      model,
      ...(params.thinking ? { thinking: params.thinking } : {}),
      modelRun: true,
      promptMode: "none",
      cleanupBundleMcpOnRunEnd: true,
      idempotencyKey: randomIdempotencyKey(),
    },
    expectFinal: true,
    timeoutMs: 120_000,
    clientName: hasModelOverride ? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT : GATEWAY_CLIENT_NAMES.CLI,
    mode: hasModelOverride ? GATEWAY_CLIENT_MODES.BACKEND : GATEWAY_CLIENT_MODES.CLI,
    ...(hasModelOverride ? { scopes: [ADMIN_SCOPE] } : {}),
  });
  return {
    ok: true,
    capability: "model.run",
    transport: "gateway" as const,
    provider: response?.result?.meta?.agentMeta?.provider,
    model: response?.result?.meta?.agentMeta?.model,
    attempts: response?.result?.meta?.agentMeta?.fallbackAttempts ?? [],
    outputs: (response?.result?.payloads ?? []).map((payload) => ({
      text: payload.text,
      mediaUrl: payload.mediaUrl,
      mediaUrls: payload.mediaUrls,
    })),
    ...(imageFiles.length > 0
      ? {
          inputs: imageFiles.map((image) => ({
            path: image.path,
            mimeType: image.mimeType,
          })),
        }
      : {}),
  } satisfies CapabilityEnvelope;
}

async function buildModelProviders() {
  const cfg = getRuntimeConfig();
  const catalog = await loadPreparedModelCatalog({ config: cfg });
  const selectedProvider = resolveSelectedProviderFromModelRef(
    resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model),
  );
  const grouped = new Map<
    string,
    {
      provider: string;
      count: number;
      defaults: string[];
      available: boolean;
      configured: boolean;
      selected: boolean;
    }
  >();
  for (const entry of catalog) {
    const current = grouped.get(entry.provider) ?? {
      provider: entry.provider,
      count: 0,
      defaults: [],
      available: true,
      configured: providerHasGenericConfig({ cfg, providerId: entry.provider }),
      selected: selectedProvider === entry.provider,
    };
    current.count += 1;
    if (current.defaults.length < 3) {
      current.defaults.push(entry.id);
    }
    grouped.set(entry.provider, current);
  }
  return [...grouped.values()].toSorted((a, b) => a.provider.localeCompare(b.provider));
}

async function runModelAuthStatus() {
  const captured: string[] = [];
  const { modelsStatusCommand } = await import("../../commands/models/list.status-command.js");
  await modelsStatusCommand(
    { json: true },
    {
      log: (...args) => captured.push(args.join(" ")),
      error: (message) => {
        throw message instanceof Error ? message : new Error(String(message));
      },
      exit: (code) => {
        throw new Error(`exit ${code}`);
      },
    },
  );
  const raw = captured.find((line) => line.trim().startsWith("{"));
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function runModelAuthLogout(provider: string, agent?: string) {
  const cfg = getRuntimeConfig();
  const agentId = agent?.trim() || resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, agentId);
  const store = loadAuthProfileStoreForRuntime(agentDir);
  const profileIds = listProfilesForProvider(store, provider);
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (nextStore) => {
      let changed = false;
      for (const profileId of profileIds) {
        if (nextStore.profiles[profileId]) {
          delete nextStore.profiles[profileId];
          changed = true;
        }
        if (nextStore.usageStats?.[profileId]) {
          delete nextStore.usageStats[profileId];
          changed = true;
        }
      }
      if (nextStore.order?.[provider]) {
        delete nextStore.order[provider];
        changed = true;
      }
      if (nextStore.lastGood?.[provider]) {
        delete nextStore.lastGood[provider];
        changed = true;
      }
      return changed;
    },
  });
  if (!updated) {
    throw new Error(`Failed to remove saved auth profiles for provider ${provider}.`);
  }
  return {
    provider,
    removedProfiles: profileIds,
  };
}

export function registerModelCapabilityCommands(capability: Command): void {
  const model = capability
    .command("model")
    .description("Text inference and model catalog commands");

  model
    .command("run")
    .description("Run a one-shot model turn")
    .requiredOption("--prompt <text>", "Prompt text")
    .option("--file <path>", "Image file", collectOption, [])
    .option("--model <provider/model>", "Model override")
    .option("--thinking <level>", "Thinking level override")
    .option("--local", "Force local execution", false)
    .option("--gateway", "Force gateway execution", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const prompt = requireModelRunPrompt(opts.prompt);
        const thinking = normalizeModelRunThinking(opts.thinking);
        const transport = resolveTransport({
          local: Boolean(opts.local),
          gateway: Boolean(opts.gateway),
          supported: ["local", "gateway"],
          defaultTransport: "local",
        });
        const result = await runModelRun({
          prompt,
          files: opts.file as string[] | undefined,
          model: opts.model as string | undefined,
          thinking,
          transport,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
      });
    });

  model
    .command("list")
    .description("List known models")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await loadPreparedModelCatalog({ config: getRuntimeConfig() });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, providerSummaryText);
      });
    });

  model
    .command("inspect")
    .description("Inspect one model catalog entry")
    .requiredOption("--model <provider/model>", "Model id")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const target = normalizeStringifiedOptionalString(opts.model) ?? "";
        const catalog = await loadPreparedModelCatalog({ config: getRuntimeConfig() });
        const entry =
          catalog.find((candidate) => `${candidate.provider}/${candidate.id}` === target) ??
          catalog.find((candidate) => candidate.id === target);
        if (!entry) {
          throw new Error(`Model not found: ${target}`);
        }
        emitJsonOrText(defaultRuntime, Boolean(opts.json), entry, (value) =>
          JSON.stringify(value, null, 2),
        );
      });
    });

  model
    .command("providers")
    .description("List model providers from the catalog")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await buildModelProviders();
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, providerSummaryText);
      });
    });

  const modelAuth = model.command("auth").description("Provider auth helpers");

  modelAuth
    .command("login")
    .description("Run provider auth login")
    .requiredOption("--provider <id>", "Provider id")
    .option("--method <id>", "Provider auth method id")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { modelsAuthLoginCommand } = await import("../../commands/models/auth.js");
        await modelsAuthLoginCommand(
          {
            provider: String(opts.provider),
            method: opts.method ? String(opts.method) : undefined,
          },
          defaultRuntime,
        );
      });
    });

  modelAuth
    .command("logout")
    .description("Remove saved auth profiles for one provider")
    .requiredOption("--provider <id>", "Provider id")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await runModelAuthLogout(
          String(opts.provider),
          typeof opts.agent === "string" ? opts.agent : undefined,
        );
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, (value) =>
          JSON.stringify(value, null, 2),
        );
      });
    });

  modelAuth
    .command("status")
    .description("Show configured auth state")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await runModelAuthStatus();
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, (value) =>
          JSON.stringify(value, null, 2),
        );
      });
    });
}
