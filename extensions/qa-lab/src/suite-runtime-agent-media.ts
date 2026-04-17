import fs from "node:fs/promises";
import path from "node:path";
import { buildQaImageGenerationConfigPatch } from "./providers/image-generation.js";
import {
  fetchJson,
  patchConfig,
  waitForGatewayHealthy,
  waitForTransportReady,
} from "./suite-runtime-gateway.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

function extractMediaPathFromText(text: string | undefined): string | undefined {
  return /MEDIA:([^\n]+)/.exec(text ?? "")?.[1]?.trim();
}

async function resolveGeneratedImagePath(params: {
  env: Pick<QaSuiteRuntimeEnv, "mock" | "gateway">;
  promptSnippet: string;
  startedAtMs: number;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    if (params.env.mock) {
      const requests = await fetchJson<Array<{ allInputText?: string; toolOutput?: string }>>(
        `${params.env.mock.baseUrl}/debug/requests`,
      );
      for (let index = requests.length - 1; index >= 0; index -= 1) {
        const request = requests[index];
        if (!(request.allInputText ?? "").includes(params.promptSnippet)) {
          continue;
        }
        const mediaPath = extractMediaPathFromText(request.toolOutput);
        if (mediaPath) {
          return mediaPath;
        }
      }
    }

    const mediaDir = path.join(
      params.env.gateway.tempRoot,
      "state",
      "media",
      "tool-image-generation",
    );
    const entries = await fs.readdir(mediaDir).catch(() => []);
    const candidates = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(mediaDir, entry);
        const stat = await fs.stat(fullPath).catch(() => null);
        if (!stat?.isFile()) {
          return null;
        }
        return {
          fullPath,
          mtimeMs: stat.mtimeMs,
        };
      }),
    );
    const match = candidates
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .filter((entry) => entry.mtimeMs >= params.startedAtMs - 1_000)
      .toSorted((left, right) => right.mtimeMs - left.mtimeMs)
      .at(0)?.fullPath;
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out after ${params.timeoutMs}ms`);
}

async function ensureImageGenerationConfigured(env: QaSuiteRuntimeEnv) {
  await patchConfig({
    env,
    patch: buildQaImageGenerationConfigPatch({
      providerMode: env.providerMode,
      providerBaseUrl: env.mock ? `${env.mock.baseUrl}/v1` : undefined,
      requiredPluginIds: env.transport.requiredPluginIds,
    }),
  });
  await waitForGatewayHealthy(env);
  await waitForTransportReady(env, 60_000);
}

export { ensureImageGenerationConfigured, extractMediaPathFromText, resolveGeneratedImagePath };
