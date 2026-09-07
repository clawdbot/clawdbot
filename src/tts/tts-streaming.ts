import type { OpenClawConfig } from "../config/types.js";
import {
  PluginRegistryResourceScope,
  createPluginRegistryResourceLease,
  withPluginRegistryResourceScope,
} from "../plugins/registry-resources.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { TtsDirectiveOverrides } from "./provider-types.js";
import { assertSpeechRuntimeAvailable } from "./runtime-availability.js";
import { normalizeSpeechText } from "./speech-text.js";
import type { TtsStreamResult, TtsSynthesisStreamResult } from "./tts-runtime-types.js";
import { executeTtsProviderAttempts, resolveTtsRequestSetup } from "./tts-synthesis-support.js";
import { resolveTtsSynthesisTarget } from "./tts-synthesis.js";

export async function streamSpeech(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
  timeoutMs?: number;
  agentId?: string;
  accountId?: string;
}): Promise<TtsSynthesisStreamResult> {
  const resources = new PluginRegistryResourceScope();
  const registration = createPluginRegistryResourceLease(resources);
  try {
    const synthesis = await registration.run(() => streamSpeechWithResources(params));
    if (!synthesis.success || !synthesis.audioStream) {
      try {
        await registration.run(() => synthesis.release?.());
      } finally {
        resources.release();
      }
      return synthesis;
    }
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = synthesis.audioStream.getReader();
    } catch (error) {
      // A provider can return a locked stream. Even reader construction failure
      // must release the transport already returned by synthesis.
      try {
        await registration.run(() => synthesis.release?.());
      } finally {
        resources.release();
      }
      throw error;
    }
    let completion: Promise<void> | undefined;
    const release = (cancel = true): Promise<void> => {
      if (!completion) {
        const cleanup = createDeferredCore();
        completion = cleanup.promise;
        // Publish completion before invoking provider code: cancellation callbacks
        // can reenter release or trigger host shutdown synchronously.
        registration.release(completion);
        try {
          cleanup.resolve(
            withPluginRegistryResourceScope(resources, async () => {
              try {
                try {
                  if (cancel) {
                    await reader.cancel();
                  }
                } finally {
                  await synthesis.release?.();
                }
              } finally {
                reader.releaseLock();
              }
            }),
          );
        } catch (error) {
          cleanup.reject(error);
        }
      }
      return completion;
    };
    return {
      ...synthesis,
      release,
      audioStream: new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (completion) {
              // Buffered audio can outlive transport release; do not reenter its retired scope.
              await completion;
              controller.close();
              return;
            }
            const chunk = await withPluginRegistryResourceScope(resources, () => reader.read());
            if (chunk.done) {
              await release(false);
              controller.close();
            } else {
              controller.enqueue(chunk.value);
            }
          } catch (error) {
            try {
              await release(false);
            } finally {
              controller.error(error);
            }
          }
        },
        cancel: () => release(),
      }),
    };
  } catch (error) {
    resources.release();
    throw error;
  }
}

async function streamSpeechWithResources(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
  timeoutMs?: number;
  agentId?: string;
  accountId?: string;
}): Promise<TtsSynthesisStreamResult> {
  assertSpeechRuntimeAvailable();
  const setup = resolveTtsRequestSetup({
    text: params.text,
    cfg: params.cfg,
    prefsPath: params.prefsPath,
    providerOverride: params.overrides?.provider,
    disableFallback: params.disableFallback,
    agentId: params.agentId,
    channelId: params.channel,
    accountId: params.accountId,
  });
  if ("error" in setup) {
    return { success: false, error: setup.error };
  }

  const { cfg, config, persona, providers } = setup;
  const target = resolveTtsSynthesisTarget(params.channel);
  return await executeTtsProviderAttempts({
    cfg,
    config,
    persona,
    providers,
    synthesisText: normalizeSpeechText(params.text),
    providerOverrides: params.overrides?.providerOverrides,
    timeoutMs: params.timeoutMs,
    target,
    logLabel: "TTS stream",
    selectOperation: ({ provider, resolvedProvider }) => {
      if (!resolvedProvider.provider.streamSynthesize) {
        return {
          kind: "skip",
          reasonCode: "unsupported_for_streaming",
          message: `${provider} does not support streaming TTS`,
        };
      }
      return {
        kind: "ready",
        synthesize: ({ prepared, cfg: runtimeCfg, target: synthesisTarget, timeoutMs }) =>
          resolvedProvider.provider.streamSynthesize!({
            text: prepared.text,
            cfg: runtimeCfg,
            providerConfig: prepared.providerConfig,
            target: synthesisTarget,
            providerOverrides: prepared.providerOverrides,
            timeoutMs,
          }),
      };
    },
    buildSuccess: ({ synthesis, ...metadata }) => ({
      success: true,
      ...metadata,
      audioStream: synthesis.audioStream,
      outputFormat: synthesis.outputFormat,
      voiceCompatible: synthesis.voiceCompatible,
      fileExtension: synthesis.fileExtension,
      target,
      release: synthesis.release,
    }),
  });
}

export async function textToSpeechStream(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
  timeoutMs?: number;
  agentId?: string;
  accountId?: string;
}): Promise<TtsStreamResult> {
  const synthesis = await streamSpeech(params);
  if (!synthesis.success || !synthesis.audioStream || !synthesis.fileExtension) {
    await synthesis.release?.();
    return {
      success: false,
      error: synthesis.error ?? "Streaming TTS conversion failed",
      persona: synthesis.persona,
      attemptedProviders: synthesis.attemptedProviders,
      attempts: synthesis.attempts,
    };
  }
  return synthesis;
}
