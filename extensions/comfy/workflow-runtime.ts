import fs from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  isProviderApiKeyConfigured,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  normalizeBaseUrl,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import {
  buildHostnameAllowlistPolicyFromSuffixAllowlist,
  fetchWithSsrFGuard,
  isPrivateOrLoopbackHost,
  mergeSsrFPolicies,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  isRecord,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  resolveUserPath,
} from "openclaw/plugin-sdk/text-runtime";

const DEFAULT_COMFY_LOCAL_BASE_URL = "http://127.0.0.1:8188";
const DEFAULT_COMFY_CLOUD_BASE_URL = "https://cloud.comfy.org";
const DEFAULT_PROMPT_INPUT_NAME = "text";
const DEFAULT_INPUT_IMAGE_INPUT_NAME = "image";
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export const DEFAULT_COMFY_MODEL = "workflow";

export type ComfyMode = "local" | "cloud";
export type ComfyCapability = "image" | "music" | "video";
export type ComfyOutputKind = "audio" | "gifs" | "images" | "videos";
export type ComfyWorkflow = Record<string, unknown>;
export type ComfyProviderConfig = Record<string, unknown>;
type ComfyFetchGuardParams = Parameters<typeof fetchWithSsrFGuard>[0];
type ComfyDispatcherPolicy = ComfyFetchGuardParams["dispatcherPolicy"];
type ComfyPromptResponse = {
  prompt_id?: string;
};
type ComfyOutputFile = {
  filename?: string;
  name?: string;
  subfolder?: string;
  type?: string;
};
type ComfyHistoryOutputEntry = Partial<Record<ComfyOutputKind, ComfyOutputFile[]>>;
type ComfyHistoryEntry = {
  outputs?: Record<string, ComfyHistoryOutputEntry>;
};
type ComfyUploadResponse = {
  name?: string;
  filename?: string;
};
type ComfyStatusResponse = {
  status?: string;
  message?: string;
  error?: string;
};
type ComfyNetworkPolicy = {
  apiPolicy?: SsrFPolicy;
};

export type ComfySourceImage = {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
};

export type ComfyGeneratedAsset = {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  nodeId: string;
};

export type ComfyWorkflowResult = {
  assets: ComfyGeneratedAsset[];
  model: string;
  promptId: string;
  outputNodeIds: string[];
};

let comfyFetchGuard = fetchWithSsrFGuard;

export function _setComfyFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void {
  comfyFetchGuard = impl ?? fetchWithSsrFGuard;
}

function readConfigBoolean(config: ComfyProviderConfig, key: string): boolean | undefined {
  const value = config[key];
  return typeof value === "boolean" ? value : undefined;
}

function readConfigInteger(config: ComfyProviderConfig, key: string): number | undefined {
  const value = config[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function getComfyConfig(cfg?: OpenClawConfig): ComfyProviderConfig {
  const raw = cfg?.models?.providers?.comfy;
  return isRecord(raw) ? raw : {};
}

function stripNestedCapabilityConfig(config: ComfyProviderConfig): ComfyProviderConfig {
  const next = { ...config };
  delete next.image;
  delete next.video;
  delete next.music;
  return next;
}

export function getComfyCapabilityConfig(
  config: ComfyProviderConfig,
  capability: ComfyCapability,
): ComfyProviderConfig {
  const shared = stripNestedCapabilityConfig(config);
  const nested = config[capability];
  if (!isRecord(nested)) {
    return shared;
  }
  return { ...shared, ...nested };
}

export function resolveComfyMode(config: ComfyProviderConfig): ComfyMode {
  return normalizeOptionalString(config.mode) === "cloud" ? "cloud" : "local";
}

function getRequiredConfigString(config: ComfyProviderConfig, key: string): string {
  const value = normalizeOptionalString(config[key]);
  if (!value) {
    throw new Error(`models.providers.comfy.${key} is required`);
  }
  return value;
}

function resolveComfyWorkflowSource(config: ComfyProviderConfig): {
  workflow?: ComfyWorkflow;
  workflowPath?: string;
} {
  const workflow = config.workflow;
  if (isRecord(workflow)) {
    return { workflow: structuredClone(workflow) };
  }
  const workflowPath = normalizeOptionalString(config.workflowPath);
  return { workflowPath };
}

async function loadComfyWorkflow(config: ComfyProviderConfig): Promise<ComfyWorkflow> {
  const source = resolveComfyWorkflowSource(config);
  if (source.workflow) {
    return source.workflow;
  }
  if (!source.workflowPath) {
    throw new Error("models.providers.comfy.<capability>.workflow or workflowPath is required");
  }

  const resolvedPath = resolveUserPath(source.workflowPath);
  const raw = await fs.readFile(resolvedPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Comfy workflow at ${resolvedPath} must be a JSON object`);
  }
  return parsed;
}

function setWorkflowInput(params: {
  workflow: ComfyWorkflow;
  nodeId: string;
  inputName: string;
  value: unknown;
}): void {
  const node = params.workflow[params.nodeId];
  if (!isRecord(node)) {
    throw new Error(`Comfy workflow missing node "${params.nodeId}"`);
  }
  const inputs = node.inputs;
  if (!isRecord(inputs)) {
    throw new Error(`Comfy workflow node "${params.nodeId}" is missing an inputs object`);
  }
  inputs[params.inputName] = params.value;
}

function resolveComfyNetworkPolicy(params: {
  baseUrl: string;
  allowPrivateNetwork: boolean;
}): ComfyNetworkPolicy {
  let parsed: URL;
  try {
    parsed = new URL(params.baseUrl);
  } catch {
    return {};
  }

  const hostname = normalizeOptionalLowercaseString(parsed.hostname) ?? "";
  if (!hostname || !params.allowPrivateNetwork || !isPrivateOrLoopbackHost(hostname)) {
    return {};
  }

  const hostnamePolicy = buildHostnameAllowlistPolicyFromSuffixAllowlist([hostname]);
  const privateNetworkPolicy = ssrfPolicyFromDangerouslyAllowPrivateNetwork(true);
  return {
    apiPolicy: mergeSsrFPolicies(hostnamePolicy, privateNetworkPolicy),
  };
}

async function readJsonResponse<T>(params: {
  url: string;
  init?: RequestInit;
  timeoutMs?: number;
  policy?: SsrFPolicy;
  dispatcherPolicy?: ComfyDispatcherPolicy;
  auditContext: string;
  errorPrefix: string;
}): Promise<T> {
  const { response, release } = await comfyFetchGuard({
    url: params.url,
    init: params.init,
    timeoutMs: params.timeoutMs,
    policy: params.policy,
    dispatcherPolicy: params.dispatcherPolicy,
    auditContext: params.auditContext,
  });
  try {
    await assertOkOrThrowHttpError(response, params.errorPrefix);
    return (await response.json()) as T;
  } finally {
    await release();
  }
}

function inferFileExtension(params: { fileName?: string; mimeType?: string }): string {
  const normalizedMime = normalizeOptionalLowercaseString(params.mimeType);
  if (normalizedMime?.includes("jpeg")) {
    return "jpg";
  }
  if (normalizedMime?.includes("png")) {
    return "png";
  }
  if (normalizedMime?.includes("webm")) {
    return "webm";
  }
  if (normalizedMime?.includes("mp4")) {
    return "mp4";
  }
  if (normalizedMime?.includes("mpeg")) {
    return "mp3";
  }
  if (normalizedMime?.includes("wav")) {
    return "wav";
  }
  const fileName = params.fileName?.trim();
  if (!fileName) {
    return "bin";
  }
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === fileName.length - 1) {
    return "bin";
  }
  return fileName.slice(dotIndex + 1);
}

function toBlobBytes(buffer: Buffer): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(arrayBuffer).set(buffer);
  return arrayBuffer;
}

async function uploadInputImage(params: {
  baseUrl: string;
  headers: Headers;
  timeoutMs: number;
  policy?: SsrFPolicy;
  dispatcherPolicy?: ComfyDispatcherPolicy;
  image: ComfySourceImage;
  mode: ComfyMode;
  capability: ComfyCapability;
}): Promise<string> {
  const form = new FormData();
  form.set(
    "image",
    new Blob([toBlobBytes(params.image.buffer)], { type: params.image.mimeType }),
    normalizeOptionalString(params.image.fileName) ||
      `input.${inferFileExtension({ mimeType: params.image.mimeType })}`,
  );
  form.set("type", "input");
  form.set("overwrite", "true");

  const headers = new Headers(params.headers);
  headers.delete("Content-Type");

  const payload = await readJsonResponse<ComfyUploadResponse>({
    url: `${params.baseUrl}${params.mode === "cloud" ? "/api/upload/image" : "/upload/image"}`,
    init: {
      method: "POST",
      headers,
      body: form,
    },
    timeoutMs: params.timeoutMs,
    policy: params.policy,
    dispatcherPolicy: params.dispatcherPolicy,
    auditContext: `comfy-${params.capability}-upload`,
    errorPrefix: "Comfy image upload failed",
  });

  const uploadedName =
    normalizeOptionalString(payload.filename) || normalizeOptionalString(payload.name);
  if (!uploadedName) {
    throw new Error("Comfy image upload response missing filename");
  }
  return uploadedName;
}

function extractHistoryEntry(history: unknown, promptId: string): ComfyHistoryEntry | null {
  if (!isRecord(history)) {
    return null;
  }
  const directOutputs = history.outputs;
  if (isRecord(directOutputs)) {
    return history as ComfyHistoryEntry;
  }
  const nested = history[promptId];
  if (isRecord(nested)) {
    return nested as ComfyHistoryEntry;
  }
  return null;
}

async function waitForLocalHistory(params: {
  baseUrl: string;
  promptId: string;
  headers: Headers;
  timeoutMs: number;
  pollIntervalMs: number;
  policy?: SsrFPolicy;
  dispatcherPolicy?: ComfyDispatcherPolicy;
}): Promise<ComfyHistoryEntry> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() <= deadline) {
    const history = await readJsonResponse<unknown>({
      url: `${params.baseUrl}/history/${params.promptId}`,
      init: {
        method: "GET",
        headers: params.headers,
      },
      timeoutMs: params.timeoutMs,
      policy: params.policy,
      dispatcherPolicy: params.dispatcherPolicy,
      auditContext: "comfy-history",
      errorPrefix: "Comfy history lookup failed",
    });

    const entry = extractHistoryEntry(history, params.promptId);
    if (entry?.outputs && Object.keys(entry.outputs).length > 0) {
      return entry;
    }

    await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
  }

  throw new Error(`Comfy workflow did not finish within ${Math.ceil(params.timeoutMs / 1000)}s`);
}

async function waitForCloudCompletion(params: {
  baseUrl: string;
  promptId: string;
  headers: Headers;
  timeoutMs: number;
  pollIntervalMs: number;
  policy?: SsrFPolicy;
  dispatcherPolicy?: ComfyDispatcherPolicy;
}): Promise<void> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() <= deadline) {
    const status = await readJsonResponse<ComfyStatusResponse>({
      url: `${params.baseUrl}/api/job/${params.promptId}/status`,
      init: {
        method: "GET",
        headers: params.headers,
      },
      timeoutMs: params.timeoutMs,
      policy: params.policy,
      dispatcherPolicy: params.dispatcherPolicy,
      auditContext: "comfy-status",
      errorPrefix: "Comfy status lookup failed",
    });

    if (status.status === "completed") {
      return;
    }
    if (status.status === "failed" || status.status === "cancelled") {
      throw new Error(
        `Comfy workflow ${status.status}: ${status.error ?? status.message ?? params.promptId}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
  }

  throw new Error(`Comfy workflow did not finish within ${Math.ceil(params.timeoutMs / 1000)}s`);
}

function collectOutputFiles(params: {
  history: ComfyHistoryEntry;
  outputNodeId?: string;
  outputKinds: readonly ComfyOutputKind[];
}): Array<{ nodeId: string; file: ComfyOutputFile }> {
  const outputs = params.history.outputs;
  if (!outputs) {
    return [];
  }

  const nodeIds = params.outputNodeId ? [params.outputNodeId] : Object.keys(outputs);
  const files: Array<{ nodeId: string; file: ComfyOutputFile }> = [];
  for (const nodeId of nodeIds) {
    const entry = outputs[nodeId];
    if (!entry) {
      continue;
    }
    for (const kind of params.outputKinds) {
      const bucket = entry[kind];
      if (!Array.isArray(bucket)) {
        continue;
      }
      for (const file of bucket) {
        files.push({ nodeId, file });
      }
    }
  }
  return files;
}

async function downloadOutputFile(params: {
  baseUrl: string;
  headers: Headers;
  timeoutMs: number;
  policy?: SsrFPolicy;
  dispatcherPolicy?: ComfyDispatcherPolicy;
  file: ComfyOutputFile;
  mode: ComfyMode;
  capability: ComfyCapability;
}): Promise<{ buffer: Buffer; mimeType: string }> {
  const fileName =
    normalizeOptionalString(params.file.filename) || normalizeOptionalString(params.file.name);
  if (!fileName) {
    throw new Error("Comfy output entry missing filename");
  }

  const query = new URLSearchParams({
    filename: fileName,
    subfolder: normalizeOptionalString(params.file.subfolder) ?? "",
    type: normalizeOptionalString(params.file.type) ?? "output",
  });
  const viewPath = params.mode === "cloud" ? "/api/view" : "/view";
  const auditContext = `comfy-${params.capability}-download`;

  const firstResponse = await comfyFetchGuard({
    url: `${params.baseUrl}${viewPath}?${query.toString()}`,
    init: {
      method: "GET",
      headers: params.headers,
      ...(params.mode === "cloud" ? { redirect: "manual" } : {}),
    },
    timeoutMs: params.timeoutMs,
    policy: params.policy,
    dispatcherPolicy: params.dispatcherPolicy,
    auditContext,
  });

  try {
    if (
      params.mode === "cloud" &&
      [301, 302, 303, 307, 308].includes(firstResponse.response.status)
    ) {
      const redirectUrl = normalizeOptionalString(firstResponse.response.headers.get("location"));
      if (!redirectUrl) {
        throw new Error("Comfy cloud output redirect missing location header");
      }
      const redirected = await comfyFetchGuard({
        url: redirectUrl,
        init: {
          method: "GET",
        },
        timeoutMs: params.timeoutMs,
        dispatcherPolicy: params.dispatcherPolicy,
        auditContext,
      });
      try {
        await assertOkOrThrowHttpError(redirected.response, "Comfy output download failed");
        const mimeType =
          normalizeOptionalString(redirected.response.headers.get("content-type")) ||
          "application/octet-stream";
        return {
          buffer: Buffer.from(await redirected.response.arrayBuffer()),
          mimeType,
        };
      } finally {
        await redirected.release();
      }
    }

    await assertOkOrThrowHttpError(firstResponse.response, "Comfy output download failed");
    const mimeType =
      normalizeOptionalString(firstResponse.response.headers.get("content-type")) ||
      "application/octet-stream";
    return {
      buffer: Buffer.from(await firstResponse.response.arrayBuffer()),
      mimeType,
    };
  } finally {
    await firstResponse.release();
  }
}

export function isComfyCapabilityConfigured(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
  capability: ComfyCapability;
}): boolean {
  const config = getComfyConfig(params.cfg);
  const capabilityConfig = getComfyCapabilityConfig(config, params.capability);
  const hasWorkflow = Boolean(
    resolveComfyWorkflowSource(capabilityConfig).workflow ||
    normalizeOptionalString(capabilityConfig.workflowPath),
  );
  const hasPromptNode = Boolean(normalizeOptionalString(capabilityConfig.promptNodeId));
  if (!hasWorkflow || !hasPromptNode) {
    return false;
  }
  if (resolveComfyMode(capabilityConfig) === "local") {
    return true;
  }
  return isProviderApiKeyConfigured({
    provider: "comfy",
    agentDir: params.agentDir,
  });
}

export async function runComfyWorkflow(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  prompt: string;
  model?: string;
  timeoutMs?: number;
  capability: ComfyCapability;
  outputKinds: readonly ComfyOutputKind[];
  inputImage?: ComfySourceImage;
}): Promise<ComfyWorkflowResult> {
  const config = getComfyConfig(params.cfg);
  const capabilityConfig = getComfyCapabilityConfig(config, params.capability);
  const mode = resolveComfyMode(capabilityConfig);
  const workflow = await loadComfyWorkflow(capabilityConfig);
  const promptNodeId = getRequiredConfigString(capabilityConfig, "promptNodeId");
  const promptInputName =
    normalizeOptionalString(capabilityConfig.promptInputName) ?? DEFAULT_PROMPT_INPUT_NAME;
  const inputImageNodeId = normalizeOptionalString(capabilityConfig.inputImageNodeId);
  const inputImageInputName =
    normalizeOptionalString(capabilityConfig.inputImageInputName) ?? DEFAULT_INPUT_IMAGE_INPUT_NAME;
  const outputNodeId = normalizeOptionalString(capabilityConfig.outputNodeId);
  const pollIntervalMs =
    readConfigInteger(capabilityConfig, "pollIntervalMs") ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs =
    readConfigInteger(capabilityConfig, "timeoutMs") ?? params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const providerModel = normalizeOptionalString(params.model) || DEFAULT_COMFY_MODEL;

  setWorkflowInput({
    workflow,
    nodeId: promptNodeId,
    inputName: promptInputName,
    value: params.prompt,
  });

  const resolvedAuth =
    mode === "cloud"
      ? await resolveApiKeyForProvider({
          provider: "comfy",
          cfg: params.cfg,
          agentDir: params.agentDir,
          store: params.authStore,
        })
      : null;
  if (mode === "cloud" && !resolvedAuth?.apiKey) {
    throw new Error("Comfy Cloud API key missing");
  }

  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: normalizeOptionalString(capabilityConfig.baseUrl),
      defaultBaseUrl:
        mode === "cloud" ? DEFAULT_COMFY_CLOUD_BASE_URL : DEFAULT_COMFY_LOCAL_BASE_URL,
      allowPrivateNetwork:
        mode === "local" || readConfigBoolean(capabilityConfig, "allowPrivateNetwork") === true,
      defaultHeaders:
        mode === "cloud"
          ? {
              "X-API-Key": resolvedAuth?.apiKey ?? "",
              "Content-Type": "application/json",
            }
          : {
              "Content-Type": "application/json",
            },
      provider: "comfy",
      capability: params.capability === "music" ? "audio" : params.capability,
      transport: "http",
    });
  const normalizedBaseUrl =
    normalizeBaseUrl(baseUrl) ||
    (mode === "cloud" ? DEFAULT_COMFY_CLOUD_BASE_URL : DEFAULT_COMFY_LOCAL_BASE_URL);
  const networkPolicy = resolveComfyNetworkPolicy({
    baseUrl: normalizedBaseUrl,
    allowPrivateNetwork,
  });

  if (params.inputImage) {
    if (!inputImageNodeId) {
      throw new Error(
        "Comfy edit requests require models.providers.comfy.<capability>.inputImageNodeId to be configured",
      );
    }
    const uploadedName = await uploadInputImage({
      baseUrl: normalizedBaseUrl,
      headers: new Headers(headers),
      timeoutMs,
      policy: networkPolicy.apiPolicy,
      dispatcherPolicy,
      image: params.inputImage,
      mode,
      capability: params.capability,
    });
    setWorkflowInput({
      workflow,
      nodeId: inputImageNodeId,
      inputName: inputImageInputName,
      value: uploadedName,
    });
  }

  const submitPayload = {
    prompt: workflow,
    ...(mode === "cloud" && resolvedAuth?.apiKey
      ? { extra_data: { api_key_comfy_org: resolvedAuth.apiKey } }
      : {}),
  };

  const promptResponse = await readJsonResponse<ComfyPromptResponse>({
    url: `${normalizedBaseUrl}${mode === "cloud" ? "/api/prompt" : "/prompt"}`,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify(submitPayload),
    },
    timeoutMs,
    policy: networkPolicy.apiPolicy,
    dispatcherPolicy,
    auditContext: `comfy-${params.capability}-generate`,
    errorPrefix: "Comfy workflow submit failed",
  });

  const promptId = normalizeOptionalString(promptResponse.prompt_id);
  if (!promptId) {
    throw new Error("Comfy workflow submit response missing prompt_id");
  }

  const history =
    mode === "cloud"
      ? await (async () => {
          await waitForCloudCompletion({
            baseUrl: normalizedBaseUrl,
            promptId,
            headers: new Headers(headers),
            timeoutMs,
            pollIntervalMs,
            policy: networkPolicy.apiPolicy,
            dispatcherPolicy,
          });
          return await readJsonResponse<unknown>({
            url: `${normalizedBaseUrl}/api/history_v2/${promptId}`,
            init: {
              method: "GET",
              headers: new Headers(headers),
            },
            timeoutMs,
            policy: networkPolicy.apiPolicy,
            dispatcherPolicy,
            auditContext: "comfy-history",
            errorPrefix: "Comfy history lookup failed",
          });
        })()
      : await waitForLocalHistory({
          baseUrl: normalizedBaseUrl,
          promptId,
          headers: new Headers(headers),
          timeoutMs,
          pollIntervalMs,
          policy: networkPolicy.apiPolicy,
          dispatcherPolicy,
        });

  const historyEntry = extractHistoryEntry(history, promptId);
  if (!historyEntry) {
    throw new Error(`Comfy history response missing outputs for prompt ${promptId}`);
  }

  const outputFiles = collectOutputFiles({
    history: historyEntry,
    outputNodeId,
    outputKinds: params.outputKinds,
  });
  if (outputFiles.length === 0) {
    throw new Error(`Comfy workflow ${promptId} completed without ${params.capability} outputs`);
  }

  const assets: ComfyGeneratedAsset[] = [];
  let assetIndex = 0;
  for (const output of outputFiles) {
    const downloaded = await downloadOutputFile({
      baseUrl: normalizedBaseUrl,
      headers: new Headers(headers),
      timeoutMs,
      policy: networkPolicy.apiPolicy,
      dispatcherPolicy,
      file: output.file,
      mode,
      capability: params.capability,
    });
    assetIndex += 1;
    const originalName =
      normalizeOptionalString(output.file.filename) || normalizeOptionalString(output.file.name);
    assets.push({
      buffer: downloaded.buffer,
      mimeType: downloaded.mimeType,
      fileName:
        originalName ||
        `${params.capability}-${assetIndex}.${inferFileExtension({ mimeType: downloaded.mimeType })}`,
      nodeId: output.nodeId,
    });
  }

  return {
    assets,
    model: providerModel,
    promptId,
    outputNodeIds: Array.from(new Set(outputFiles.map((entry) => entry.nodeId))),
  };
}
