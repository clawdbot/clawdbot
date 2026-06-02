#!/usr/bin/env node
/**
 * Live repro for WebChat auto-TTS fix (PR #82701).
 * Run: pnpm exec tsx scripts/repro/webchat-auto-tts-live-proof.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { maybeApplyTtsToPayload } from "../../packages/speech-core/src/tts.ts";
import { buildWebchatAudioContentBlocksFromReplyPayloads } from "../../src/gateway/server-methods/chat-webchat-media.ts";
import { createPluginRecord } from "../../src/plugins/loader-records.ts";
import { createPluginRegistry } from "../../src/plugins/registry.ts";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../src/plugins/runtime.ts";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

export function cleanupProofArtifacts({ mediaPath, prefsPath }) {
  if (mediaPath) {
    fs.rmSync(path.dirname(mediaPath), { recursive: true, force: true });
  }
  fs.rmSync(prefsPath, { force: true });
}

async function main() {
  resetPluginRuntimeStateForTest();
  let mediaPath;
  const pluginRegistry = createPluginRegistry({
    logger: noopLogger,
    runtime: {},
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "repro-mock-tts",
    name: "Repro Mock TTS",
    source: "scripts/repro/webchat-auto-tts-live-proof.mjs",
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  pluginRegistry.registerSpeechProvider(record, {
    id: "mock",
    label: "Mock",
    autoSelectOrder: 1,
    isConfigured: () => true,
    synthesize: async (request) => ({
      audioBuffer: Buffer.from("voice"),
      fileExtension: ".ogg",
      outputFormat: "ogg",
      voiceCompatible: request.target === "voice-note",
    }),
  });
  setActivePluginRegistry(pluginRegistry.registry);

  const prefsPath = path.join(os.tmpdir(), `openclaw-webchat-tts-proof-${process.pid}.json`);
  const cfg = {
    messages: {
      tts: {
        enabled: true,
        provider: "mock",
        prefsPath,
      },
    },
  };

  try {
    const accumulatedBlockText =
      "WebChat streams block text; dispatch synthesizes one TTS tail with kind final.";
    const blockResult = await maybeApplyTtsToPayload({
      payload: { text: accumulatedBlockText },
      cfg,
      channel: "webchat",
      kind: "block",
    });
    console.log("maybeApplyTtsToPayload(kind=block).mediaUrl =", blockResult.mediaUrl ?? "(none)");

    const tailResult = await maybeApplyTtsToPayload({
      payload: { text: accumulatedBlockText },
      cfg,
      channel: "webchat",
      kind: "final",
    });
    console.log("maybeApplyTtsToPayload(kind=final).mediaUrl =", tailResult.mediaUrl ?? "(none)");
    console.log(
      "maybeApplyTtsToPayload(kind=final).trustedLocalMedia =",
      tailResult.trustedLocalMedia ?? false,
    );

    mediaPath = tailResult.mediaUrl;
    if (!mediaPath || !fs.existsSync(mediaPath)) {
      throw new Error("expected final-mode tail TTS to write a local media file");
    }

    // Same shape as dispatch-from-config accumulated block TTS-only final payload.
    const ttsOnlyPayload = {
      mediaUrl: tailResult.mediaUrl,
      audioAsVoice: tailResult.audioAsVoice,
      spokenText: accumulatedBlockText,
      trustedLocalMedia: true,
    };
    console.log("dispatch ttsOnlyPayload.trustedLocalMedia =", ttsOnlyPayload.trustedLocalMedia);

    const localRoots = [path.dirname(mediaPath)];
    const trustedBlocks = await buildWebchatAudioContentBlocksFromReplyPayloads([ttsOnlyPayload], {
      localRoots,
    });
    const untrustedBlocks = await buildWebchatAudioContentBlocksFromReplyPayloads(
      [{ mediaUrl: mediaPath }],
      { localRoots },
    );
    console.log(
      "buildWebchatAudioContentBlocksFromReplyPayloads(ttsOnlyPayload).length =",
      trustedBlocks.length,
    );
    console.log(
      "buildWebchatAudioContentBlocksFromReplyPayloads(untrusted).length =",
      untrustedBlocks.length,
    );
  } finally {
    cleanupProofArtifacts({ mediaPath, prefsPath });
    resetPluginRuntimeStateForTest();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
