import path from "node:path";
import type { Command } from "commander";
import { getRuntimeConfig } from "../../config/config.js";
import { inspectLocalAudioSelection } from "../../media-understanding/local-audio.js";
import { buildMediaUnderstandingRegistry } from "../../media-understanding/provider-registry.js";
import { transcribeAudioFile } from "../../media-understanding/runtime.js";
import { defaultRuntime } from "../../runtime.js";
import { getProviderEnvVars } from "../../secrets/provider-env-vars.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { getModelsCommandSecretTargetIds } from "../command-secret-targets.js";
import { isMissingMediaUnderstandingProvider } from "./media-understanding-result.js";
import type { CapabilityEnvelope } from "./metadata.js";
import {
  emitJsonOrText,
  formatEnvelopeForText,
  providerHasGenericConfig,
  providerSummaryText,
  requireProviderModelOverride,
  resolveLocalCapabilityRuntimeConfig,
} from "./shared.js";

async function runAudioTranscribe(params: {
  file: string;
  language?: string;
  model?: string;
  prompt?: string;
}) {
  const cfg = await resolveLocalCapabilityRuntimeConfig({
    commandName: "infer audio transcribe",
    targetIds: getModelsCommandSecretTargetIds(),
  });
  const activeModel = requireProviderModelOverride(params.model);
  const result = await transcribeAudioFile({
    filePath: path.resolve(params.file),
    cfg,
    language: params.language,
    activeModel,
    prompt: params.prompt,
  });
  if (!result.text) {
    if (isMissingMediaUnderstandingProvider(result)) {
      throw new Error(
        "No audio transcription provider is configured or ready. Configure tools.media.audio.models, or pass --model <provider/model> after configuring that provider's auth/API key.",
      );
    }
    throw new Error(`No transcript returned for audio: ${path.resolve(params.file)}`);
  }
  return {
    ok: true,
    capability: "audio.transcribe",
    transport: "local" as const,
    attempts: [],
    outputs: [{ path: path.resolve(params.file), text: result.text, kind: "audio.transcription" }],
  } satisfies CapabilityEnvelope;
}

export function registerAudioCapabilityCommands(capability: Command): void {
  const audio = capability.command("audio").description("Audio transcription");

  audio
    .command("transcribe")
    .description("Transcribe one audio file")
    .requiredOption("--file <path>", "Audio file")
    .option("--language <code>", "Language hint")
    .option("--prompt <text>", "Prompt hint")
    .option("--model <provider/model>", "Model override")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await runAudioTranscribe({
          file: String(opts.file),
          language: opts.language as string | undefined,
          model: opts.model as string | undefined,
          prompt: opts.prompt as string | undefined,
        });
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
      });
    });

  audio
    .command("providers")
    .description("List audio transcription providers")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const cfg = getRuntimeConfig();
        const remoteProviders = [...buildMediaUnderstandingRegistry(undefined, cfg).values()]
          .filter((provider) => provider.capabilities?.includes("audio"))
          .map((provider) => ({
            available: true,
            configured: providerHasGenericConfig({
              cfg,
              providerId: provider.id,
              envVars: getProviderEnvVars(provider.id, {
                config: cfg,
                includeUntrustedWorkspacePlugins: false,
              }),
            }),
            selected: false,
            id: provider.id,
            capabilities: provider.capabilities,
            defaultModels: provider.defaultModels,
          }));
        const localSelection = await inspectLocalAudioSelection();
        const localProviders = localSelection.candidates
          .filter((candidate) => candidate.available)
          .map((candidate) =>
            Object.assign(
              {
                available: candidate.available,
                configured: candidate.ready,
                selected: false,
                localFallbackSelected: candidate.selected,
                id: `local/${candidate.id}`,
                transport: "local-cli",
                command: candidate.command,
                observedBackend: candidate.observedBackend ?? "unknown",
                evidence: candidate.evidence,
              },
              candidate.capableBackend ? { capableBackend: candidate.capableBackend } : {},
              candidate.requestedBackend ? { requestedBackend: candidate.requestedBackend } : {},
              candidate.reason ? { reason: candidate.reason } : {},
            ),
          );
        const providers = [...remoteProviders, ...localProviders];
        emitJsonOrText(defaultRuntime, Boolean(opts.json), providers, providerSummaryText);
      });
    });
}
