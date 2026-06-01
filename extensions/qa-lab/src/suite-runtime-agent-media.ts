import fs from "node:fs/promises";
import path from "node:path";
import { buildQaImageGenerationConfigPatch } from "./providers/image-generation.js";
import {
  fetchJson,
  patchConfig,
  readConfigSnapshot,
  waitForGatewayHealthy,
  waitForTransportReady,
} from "./suite-runtime-gateway.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

function extractMediaPathFromText(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const details = (parsed as Record<string, unknown>).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  const media = (details as Record<string, unknown>).media;
  if (!media || typeof media !== "object" || Array.isArray(media)) {
    return undefined;
  }
  return readFirstMediaPath(media);
}

function readFirstMediaPath(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const media = value as Record<string, unknown>;
  for (const key of ["mediaUrl", "path", "filePath"] as const) {
    const candidate = media[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  const mediaUrls = media.mediaUrls;
  if (Array.isArray(mediaUrls)) {
    const mediaUrl = mediaUrls.find(
      (candidate) => typeof candidate === "string" && candidate.trim(),
    );
    if (typeof mediaUrl === "string" && mediaUrl.trim()) {
      return mediaUrl.trim();
    }
  }
  const attachments = media.attachments;
  if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      const mediaPath = readFirstMediaPath(attachment);
      if (mediaPath) {
        return mediaPath;
      }
    }
  }
  return undefined;
}

function readPluginAllow(config: Record<string, unknown>) {
  const plugins = config.plugins;
  if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) {
    return [];
  }
  const allow = (plugins as { allow?: unknown }).allow;
  return Array.isArray(allow)
    ? allow.filter(
        (pluginId): pluginId is string => typeof pluginId === "string" && pluginId.length > 0,
      )
    : [];
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
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  throw new Error(`timed out after ${params.timeoutMs}ms`);
}

async function ensureImageGenerationConfigured(env: QaSuiteRuntimeEnv) {
  const snapshot = await readConfigSnapshot(env);
  await patchConfig({
    env,
    patch: buildQaImageGenerationConfigPatch({
      providerMode: env.providerMode,
      providerBaseUrl: env.mock ? `${env.mock.baseUrl}/v1` : undefined,
      requiredPluginIds: env.transport.requiredPluginIds,
      existingPluginIds: readPluginAllow(snapshot.config),
    }),
  });
  await waitForGatewayHealthy(env);
  await waitForTransportReady(env, 60_000);
}

export { ensureImageGenerationConfigured, extractMediaPathFromText, resolveGeneratedImagePath };
