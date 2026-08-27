// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: MIT

import {
  assertOkOrThrowProviderError,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const NVIDIA_SPEECH_CATALOG_URL =
  "https://raw.githubusercontent.com/nvidia-riva/Nemotron-speech-skills/main/skills/nemotron-speech/references/speech-models.v1.json";

export const NVIDIA_CATALOG_REALTIME_ASR_MODEL_ID = "nvidia/nemotron-asr-streaming";
export const NVIDIA_CATALOG_TTS_MODEL_ID = "nvidia/magpie-tts-multilingual";

const CATALOG_FETCH_TIMEOUT_MS = 3_000;
const CATALOG_MAX_BYTES = 256 * 1_024;
const CATALOG_MAX_MODELS = 128;
const NVCF_INVOCATION_SUFFIX = ".invocation.api.nvcf.nvidia.com";
const NVCF_GRPC_SERVER = "grpc.nvcf.nvidia.com:443";
const NVCF_REALTIME_WEBSOCKET_URL =
  "wss://grpc.nvcf.nvidia.com:443/v1/realtime?intent=transcription";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL_ID_PATTERN = /^nvidia\/[a-z0-9][a-z0-9._-]{0,126}$/;
const FUNCTION_NAME_PATTERN = /^ai-[a-z0-9][a-z0-9_-]{0,126}$/;

type NvidiaSpeechModality = "asr" | "tts" | "nmt";
type NvidiaSpeechStatus = "active" | "transitioning" | "deprecated";

function isNvidiaSpeechModality(value: unknown): value is NvidiaSpeechModality {
  return value === "asr" || value === "tts" || value === "nmt";
}

function isNvidiaSpeechStatus(value: unknown): value is NvidiaSpeechStatus {
  return value === "active" || value === "transitioning" || value === "deprecated";
}

type NvidiaSpeechCloudHttp = {
  functionName: string;
  functionId: string;
  transport: "http";
  baseUrl: string;
  requestStyle: "openai-audio" | "riva-tts-http";
  defaultLanguage?: string;
};

export type NvidiaSpeechRealtime = {
  transport: "websocket";
  sessionUrl: string;
  websocketUrl: typeof NVCF_REALTIME_WEBSOCKET_URL;
  requestStyle: "nvcf-realtime-transcription";
};

type NvidiaSpeechCloudGrpc = {
  functionName: string;
  functionId: string;
  transport: "grpc";
  server: typeof NVCF_GRPC_SERVER;
  rpcMode: "offline" | "streaming" | "online";
  defaultLanguage?: string;
  realtime?: NvidiaSpeechRealtime;
};

export type NvidiaSpeechCatalogModel = {
  id: string;
  displayName: string;
  modality: NvidiaSpeechModality;
  status: NvidiaSpeechStatus;
  capabilities: Record<string, unknown>;
  selection: Record<string, unknown>;
  cloud: NvidiaSpeechCloudHttp | NvidiaSpeechCloudGrpc;
};

type NvidiaSpeechCatalog = {
  schemaVersion: 1;
  catalogId: string;
  updatedAt: string;
  defaults: Record<NvidiaSpeechModality, Record<string, string>>;
  models: NvidiaSpeechCatalogModel[];
};

let activeCatalog: NvidiaSpeechCatalog | undefined;
let catalogWarmup: Promise<void> | undefined;

export function resolveNvidiaSpeechCatalogModel(params: {
  id: string;
  modality: NvidiaSpeechModality;
}): NvidiaSpeechCatalogModel | undefined {
  return findCatalogModel(activeCatalog, params);
}

export function resolveNvidiaSpeechCatalogDefault(params: {
  modality: NvidiaSpeechModality;
  key: string;
}): NvidiaSpeechCatalogModel | undefined {
  const id = activeCatalog?.defaults[params.modality]?.[params.key];
  return id ? findCatalogModel(activeCatalog, { id, modality: params.modality }) : undefined;
}

function findCatalogModel(
  catalog: NvidiaSpeechCatalog | undefined,
  params: { id: string; modality: NvidiaSpeechModality },
): NvidiaSpeechCatalogModel | undefined {
  return catalog?.models.find(
    (model) =>
      model.id === params.id && model.modality === params.modality && model.status !== "deprecated",
  );
}

/** Loads catalog metadata during plugin setup; request dispatch only reads the process-stable result. */
export function warmNvidiaSpeechCatalog(): Promise<void> {
  if (catalogWarmup) {
    return catalogWarmup;
  }
  catalogWarmup = fetchNvidiaSpeechCatalog()
    .then((catalog) => {
      activeCatalog = catalog;
    })
    .catch(() => {
      // Compiled endpoint metadata remains available for the lifetime of this process.
    });
  return catalogWarmup;
}

async function fetchNvidiaSpeechCatalog(): Promise<NvidiaSpeechCatalog> {
  const { response, release } = await fetchWithSsrFGuard({
    url: NVIDIA_SPEECH_CATALOG_URL,
    init: { method: "GET", headers: { Accept: "application/json" } },
    timeoutMs: CATALOG_FETCH_TIMEOUT_MS,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(NVIDIA_SPEECH_CATALOG_URL),
    auditContext: "nvidia-speech-model-catalog",
  });
  try {
    await assertOkOrThrowProviderError(response, "NVIDIA speech catalog request failed");
    const payload = await readProviderJsonResponse<unknown>(response, "nvidia speech catalog", {
      maxBytes: CATALOG_MAX_BYTES,
    });
    const catalog = parseNvidiaSpeechCatalog(payload);
    if (!catalog) {
      throw new Error("NVIDIA speech catalog response failed schema validation");
    }
    return catalog;
  } finally {
    await release();
  }
}

function parseNvidiaSpeechCatalog(payload: unknown): NvidiaSpeechCatalog | undefined {
  if (
    !isRecord(payload) ||
    payload.schemaVersion !== 1 ||
    typeof payload.catalogId !== "string" ||
    !payload.catalogId.trim() ||
    typeof payload.updatedAt !== "string" ||
    !isIsoTimestamp(payload.updatedAt) ||
    !isRecord(payload.defaults) ||
    !Array.isArray(payload.models) ||
    payload.models.length === 0 ||
    payload.models.length > CATALOG_MAX_MODELS
  ) {
    return undefined;
  }

  const models: NvidiaSpeechCatalogModel[] = [];
  for (const row of payload.models) {
    const model = parseNvidiaSpeechCatalogModel(row);
    if (!model || models.some((candidate) => candidate.id === model.id)) {
      return undefined;
    }
    models.push(model);
  }
  const defaults = parseDefaults(payload.defaults, models);
  if (!defaults) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    catalogId: payload.catalogId,
    updatedAt: payload.updatedAt,
    defaults,
    models,
  };
}

function parseNvidiaSpeechCatalogModel(row: unknown): NvidiaSpeechCatalogModel | undefined {
  if (
    !isRecord(row) ||
    typeof row.id !== "string" ||
    !MODEL_ID_PATTERN.test(row.id) ||
    typeof row.displayName !== "string" ||
    !isBoundedText(row.displayName, 200) ||
    !isNvidiaSpeechModality(row.modality) ||
    !isNvidiaSpeechStatus(row.status) ||
    !isRecord(row.capabilities) ||
    !isRecord(row.selection)
  ) {
    return undefined;
  }
  const modality = row.modality;
  const cloud = parseNvidiaSpeechCloud(row.cloud, modality);
  if (!cloud) {
    return undefined;
  }
  return {
    id: row.id,
    displayName: row.displayName,
    modality,
    status: row.status,
    capabilities: row.capabilities,
    selection: row.selection,
    cloud,
  };
}

function parseNvidiaSpeechCloud(
  value: unknown,
  modality: NvidiaSpeechModality,
): NvidiaSpeechCloudHttp | NvidiaSpeechCloudGrpc | undefined {
  if (
    !isRecord(value) ||
    typeof value.functionName !== "string" ||
    !FUNCTION_NAME_PATTERN.test(value.functionName) ||
    typeof value.functionId !== "string" ||
    !UUID_PATTERN.test(value.functionId) ||
    (value.defaultLanguage !== undefined && !isBoundedText(value.defaultLanguage, 32))
  ) {
    return undefined;
  }
  if (value.transport === "http") {
    if (
      typeof value.baseUrl !== "string" ||
      !isTrustedNvcfInvocationBaseUrl(value.baseUrl, value.functionId) ||
      (value.requestStyle !== "openai-audio" && value.requestStyle !== "riva-tts-http") ||
      (modality === "asr" && value.requestStyle !== "openai-audio") ||
      (modality === "tts" && value.requestStyle !== "riva-tts-http") ||
      modality === "nmt"
    ) {
      return undefined;
    }
    return {
      functionName: value.functionName,
      functionId: value.functionId.toLowerCase(),
      transport: "http",
      baseUrl: value.baseUrl,
      requestStyle: value.requestStyle,
      ...(value.defaultLanguage ? { defaultLanguage: value.defaultLanguage } : {}),
    };
  }
  if (
    value.transport !== "grpc" ||
    value.server !== NVCF_GRPC_SERVER ||
    (value.rpcMode !== "offline" && value.rpcMode !== "streaming" && value.rpcMode !== "online")
  ) {
    return undefined;
  }
  const realtime = parseNvidiaSpeechRealtime(value.realtime, value.functionId);
  if (value.realtime !== undefined && (modality !== "asr" || !realtime)) {
    return undefined;
  }
  return {
    functionName: value.functionName,
    functionId: value.functionId.toLowerCase(),
    transport: "grpc",
    server: NVCF_GRPC_SERVER,
    rpcMode: value.rpcMode,
    ...(value.defaultLanguage ? { defaultLanguage: value.defaultLanguage } : {}),
    ...(realtime ? { realtime } : {}),
  };
}

function parseNvidiaSpeechRealtime(
  value: unknown,
  functionId: string,
): NvidiaSpeechRealtime | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const expectedSessionUrl = `https://${functionId.toLowerCase()}${NVCF_INVOCATION_SUFFIX}/v1/realtime/transcription_sessions`;
  if (
    value.transport !== "websocket" ||
    value.sessionUrl !== expectedSessionUrl ||
    value.websocketUrl !== NVCF_REALTIME_WEBSOCKET_URL ||
    value.requestStyle !== "nvcf-realtime-transcription"
  ) {
    return undefined;
  }
  return {
    transport: "websocket",
    sessionUrl: expectedSessionUrl,
    websocketUrl: NVCF_REALTIME_WEBSOCKET_URL,
    requestStyle: "nvcf-realtime-transcription",
  };
}

function parseDefaults(
  value: Record<string, unknown>,
  models: readonly NvidiaSpeechCatalogModel[],
): NvidiaSpeechCatalog["defaults"] | undefined {
  const result: Partial<NvidiaSpeechCatalog["defaults"]> = {};
  const modalities: readonly NvidiaSpeechModality[] = ["asr", "tts", "nmt"];
  for (const modality of modalities) {
    const entries = value[modality];
    if (!isRecord(entries) || Object.keys(entries).length === 0) {
      return undefined;
    }
    const parsed: Record<string, string> = {};
    for (const [key, modelId] of Object.entries(entries)) {
      if (
        !isBoundedText(key, 80) ||
        typeof modelId !== "string" ||
        !models.some((model) => model.id === modelId && model.modality === modality)
      ) {
        return undefined;
      }
      parsed[key] = modelId;
    }
    result[modality] = parsed;
  }
  if (!result.asr || !result.tts || !result.nmt) {
    return undefined;
  }
  return { asr: result.asr, tts: result.tts, nmt: result.nmt };
}

function isTrustedNvcfInvocationBaseUrl(value: string, functionId: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.hostname === `${functionId.toLowerCase()}${NVCF_INVOCATION_SUFFIX}`
    );
  } catch {
    return false;
  }
}

function isIsoTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    return false;
  }
  for (const char of trimmed) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) {
      return false;
    }
  }
  return true;
}
