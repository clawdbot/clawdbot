import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../../agents/memory-search.js";
import { getRuntimeConfig } from "../../config/config.js";
import { createEmbeddingProvider } from "../../plugin-sdk/memory-core-bundled-runtime.js";
import { listEmbeddingProviders } from "../../plugins/embedding-provider-runtime.js";
import { listMemoryEmbeddingProviders } from "../../plugins/memory-embedding-providers.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { getMemoryEmbeddingCommandSecretTargetIds } from "../command-secret-targets.js";
import { collectOption } from "../program/helpers.js";
import type { CapabilityEnvelope } from "./metadata.js";
import {
  emitJsonOrText,
  formatEnvelopeForText,
  providerHasGenericConfig,
  providerSummaryText,
  resolveLocalCapabilityRuntimeConfig,
  resolveModelRefOverride,
} from "./shared.js";

async function runMemoryEmbeddingCreate(params: {
  texts: string[];
  provider?: string;
  model?: string;
}) {
  const cfg = await resolveLocalCapabilityRuntimeConfig({
    commandName: "infer embedding create",
    targetIds: getMemoryEmbeddingCommandSecretTargetIds(),
  });
  const modelRef = resolveModelRefOverride(params.model);
  const requestedProvider = normalizeOptionalString(params.provider) || modelRef.provider || "auto";
  const result = await createEmbeddingProvider({
    config: cfg,
    agentDir: resolveAgentDir(cfg, resolveDefaultAgentId(cfg)),
    provider: requestedProvider,
    fallback: "none",
    model: modelRef.model ?? "",
  });
  if (!result.provider) {
    throw new Error(result.providerUnavailableReason ?? "No embedding provider available.");
  }
  const embeddings = await result.provider.embedBatch(params.texts);
  return {
    ok: true,
    capability: "embedding.create",
    transport: "local" as const,
    provider: result.provider.id,
    model: result.provider.model,
    attempts: result.fallbackFrom
      ? [{ provider: result.fallbackFrom, outcome: "failed", error: result.fallbackReason }]
      : [],
    outputs: embeddings.map((embedding, index) => ({
      text: params.texts[index],
      embedding,
      dimensions: embedding.length,
    })),
  } satisfies CapabilityEnvelope;
}

export function registerEmbeddingCapabilityCommands(capability: Command): void {
  const embedding = capability.command("embedding").description("Embedding providers");

  embedding
    .command("create")
    .description("Create embeddings")
    .requiredOption("--text <text>", "Input text", collectOption, [])
    .option("--provider <id>", "Provider id")
    .option("--model <provider/model>", "Model override")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await runMemoryEmbeddingCreate({
          texts: opts.text as string[],
          provider: opts.provider as string | undefined,
          model: opts.model as string | undefined,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
      });
    });

  embedding
    .command("providers")
    .description("List embedding providers")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const cfg = getRuntimeConfig();
        const agentId = resolveDefaultAgentId(cfg);
        const resolvedMemory = resolveMemorySearchConfig(cfg, agentId);
        const selectedProvider = resolvedMemory?.provider;
        const providers = new Map(
          listMemoryEmbeddingProviders().map((provider) => [
            provider.id,
            {
              id: provider.id,
              defaultModel: provider.defaultModel,
              transport: provider.transport,
              autoSelectPriority: provider.autoSelectPriority,
            },
          ]),
        );
        for (const provider of listEmbeddingProviders(cfg)) {
          if (providers.has(provider.id)) {
            continue;
          }
          providers.set(provider.id, {
            id: provider.id,
            defaultModel: provider.defaultModel,
            transport: provider.transport,
            autoSelectPriority: undefined,
          });
        }
        if (selectedProvider && !providers.has(selectedProvider)) {
          providers.set(selectedProvider, {
            id: selectedProvider,
            defaultModel: resolvedMemory?.model || undefined,
            transport: providerHasGenericConfig({ cfg, providerId: selectedProvider })
              ? "remote"
              : undefined,
            autoSelectPriority: undefined,
          });
        }
        const result = Array.from(providers.values()).map((provider) => ({
          available: true,
          configured:
            provider.id === selectedProvider ||
            providerHasGenericConfig({
              cfg,
              providerId: provider.id,
            }),
          selected: provider.id === selectedProvider,
          id: provider.id,
          defaultModel: provider.defaultModel,
          transport: provider.transport,
          autoSelectPriority: provider.autoSelectPriority,
        }));
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, providerSummaryText);
      });
    });
}
