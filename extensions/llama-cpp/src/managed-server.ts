import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  readProviderJsonResponse,
  readProviderTextResponse,
} from "openclaw/plugin-sdk/provider-http";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { fetchConfiguredLocalOriginWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime-internal";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_LLAMA_CPP_CONTEXT_SIZE,
  DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_REVISION,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_SHA256,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_SIZE_BYTES,
  DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE,
  DEFAULT_LLAMA_CPP_MODEL_URI,
  LLAMA_CPP_DEFAULT_PORT,
  resolveCachedLlamaCppModelPath,
  resolveHomePath,
  resolveLegacyLlamaCppModelCacheDir,
  resolveLlamaCppModelCacheDir,
  resolveLlamaCppModelSource,
} from "./defaults.js";
import {
  downloadVerifiedFile,
  ensureLlamaServerInstalled,
  resolveManagedLlamaServerPaths,
  sha256File,
  type LlamaDownloadProgress,
  type LlamaServerAsset,
} from "./llama-server-install.js";
import { resolveLlamaCppCatalogArtifact } from "./model-catalog.js";

type ModelArtifact = {
  fileName: string;
  url: string;
  expectedSize?: number;
  expectedSha256?: string;
};

export type ManagedLlamaServer = {
  command: string;
  baseUrl: string;
  healthUrl: string;
  args: string[];
};

export type ManagedLlamaChatModel =
  | { mode: "preserve" }
  | { mode: "remove" }
  | {
      mode: "configure";
      id: string;
      path: string;
      contextSize?: number;
      maxTokens?: number;
    };

export type LlamaServerRuntimeFacts = {
  engine: "llama.cpp";
  state: "ready" | "failed";
  backend?: LlamaServerAsset["backend"];
  buildInfo?: string;
  model?: { id: string; path?: string };
  capabilities?: { vision: boolean; draft: boolean };
  endpoints: {
    health: "ready" | "unavailable";
    models: "ready" | "unavailable";
    props: "ready" | "unavailable";
    metrics: "ready" | "unavailable";
  };
  loadError?: string;
};

const modelPromises = new Map<string, Promise<string>>();
const resolvedModelArtifacts = new Map<string, ModelArtifact>(); // Presets remain request-scoped.
const presetState = {
  appliedRevisions: new Map<string, string>(),
  desiredRevisions: new Map<string, string>(),
  transition: Promise.resolve(),
};
const LLAMA_CPP_EMBEDDING_UBATCH_SIZE = 2048; // Fit one input in one physical batch.
const LLAMA_CPP_PRESET_RELOAD_TIMEOUT_MS = 15_000; // b10534 unload window: 10 seconds.

function parseHuggingFaceSource(source: string): {
  user: string;
  repository: string;
  file?: string;
  revision: string;
  tag?: string;
} {
  const content = source.replace(/^(?:hf|huggingface):(?:\/\/)?/iu, "");
  const [pathPart, revisionPart] = content.split("#", 2);
  const [user, repositoryWithTag, ...fileParts] = (pathPart ?? "").split("/");
  const [repository, ...tagParts] = (repositoryWithTag ?? "").split(":");
  if (!user || !repository) {
    throw new Error(`Invalid Hugging Face model URI: ${source}`);
  }
  return {
    user,
    repository,
    file: fileParts.length > 0 ? fileParts.join("/") : undefined,
    revision: revisionPart || "main",
    tag: tagParts.length > 0 ? tagParts.join(":") : undefined,
  };
}

async function resolveHuggingFaceArtifact(
  source: string,
  signal?: AbortSignal,
): Promise<ModelArtifact> {
  const parsed = parseHuggingFaceSource(source);
  let file = parsed.file;
  let expectedSize: number | undefined;
  if (!file) {
    const tag = parsed.tag || "latest";
    const manifestUrl = `https://huggingface.co/v2/${encodeURIComponent(parsed.user)}/${encodeURIComponent(parsed.repository)}/manifests/${encodeURIComponent(tag)}`;
    const { response, release } = await fetchWithSsrFGuard({
      url: manifestUrl,
      init: { headers: { "user-agent": "llama-cpp" } },
      signal,
      requireHttps: true,
      policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(manifestUrl),
      auditContext: "llama-cpp-model-resolve",
    });
    try {
      if (!response.ok) {
        throw new Error(`Cannot resolve ${source}: HTTP ${response.status}`);
      }
      const ggufFile = asOptionalRecord(
        asOptionalRecord(
          await readProviderJsonResponse(response, "llama.cpp Hugging Face manifest"),
        )?.ggufFile,
      );
      file = typeof ggufFile?.rfilename === "string" ? ggufFile.rfilename : undefined;
      expectedSize = typeof ggufFile?.size === "number" ? ggufFile.size : undefined;
      if (!file) {
        throw new Error(`Hugging Face did not return a GGUF file for ${source}`);
      }
    } finally {
      await release();
    }
  }
  const encodedFile = file.split("/").map(encodeURIComponent).join("/");
  const url = `https://huggingface.co/${encodeURIComponent(parsed.user)}/${encodeURIComponent(parsed.repository)}/resolve/${encodeURIComponent(parsed.revision)}/${encodedFile}?download=true`;
  const fileInfoUrl = `https://huggingface.co/api/models/${encodeURIComponent(parsed.user)}/${encodeURIComponent(parsed.repository)}/paths-info/${encodeURIComponent(parsed.revision)}`;
  const { response: fileInfoResponse, release: releaseFileInfo } = await fetchWithSsrFGuard({
    url: fileInfoUrl,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "llama-cpp" },
      body: JSON.stringify({ paths: [file], expand: false }),
    },
    signal,
    requireHttps: true,
    policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(fileInfoUrl),
    auditContext: "llama-cpp-model-resolve",
  });
  let fileInfo: unknown;
  try {
    if (!fileInfoResponse.ok) {
      throw new Error(
        `Cannot read Hugging Face integrity metadata for ${source}: HTTP ${fileInfoResponse.status}`,
      );
    }
    fileInfo = await readProviderJsonResponse(
      fileInfoResponse,
      "llama.cpp Hugging Face file metadata",
    );
  } finally {
    await releaseFileInfo();
  }
  const fileRow = Array.isArray(fileInfo)
    ? fileInfo.map((entry) => asOptionalRecord(entry)).find((entry) => entry?.path === file)
    : undefined;
  const lfs = asOptionalRecord(fileRow?.lfs);
  const expectedSha256 =
    typeof lfs?.oid === "string" && /^[a-f\d]{64}$/iu.test(lfs.oid)
      ? lfs.oid.toLowerCase()
      : undefined;
  expectedSize = expectedSize ?? (typeof fileRow?.size === "number" ? fileRow.size : undefined);
  if (!expectedSha256) {
    throw new Error(`Hugging Face did not publish a SHA-256 LFS identity for ${source}`);
  }
  const safeName = `hf_${[
    parsed.user,
    parsed.repository,
    parsed.revision === "main" ? "" : parsed.revision,
    ...file.split("/"),
  ]
    .filter(Boolean)
    .join("_")
    .replace(/[^a-z\d._-]+/giu, "_")}`;
  return { fileName: safeName, url, expectedSize, expectedSha256 };
}

function defaultArtifact(source: string): ModelArtifact | undefined {
  const recipe = resolveLlamaCppCatalogArtifact(source);
  if (recipe) {
    return recipe;
  }
  if (source === DEFAULT_LLAMA_CPP_EMBEDDING_MODEL) {
    return {
      fileName: DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE,
      url: `https://huggingface.co/ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/resolve/${DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_REVISION}/embeddinggemma-300m-qat-Q8_0.gguf?download=true`,
      expectedSize: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_SIZE_BYTES,
      expectedSha256: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_SHA256,
    };
  }
  return undefined;
}

async function assertGguf(filePath: string): Promise<void> {
  const handle = await fsp.open(filePath, "r").catch((error: unknown) => {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      throw new Error(
        `Model file is missing: ${filePath}. Run interactive llama.cpp setup or correct params.modelPath.`,
        { cause: error },
      );
    }
    throw error;
  });
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== 4 || header.toString("ascii") !== "GGUF") {
      throw new Error(`Model is not a GGUF file: ${filePath}`);
    }
  } finally {
    await handle.close();
  }
}

async function resolveModelArtifact(source: string, signal?: AbortSignal): Promise<ModelArtifact> {
  const known = defaultArtifact(source);
  if (known) {
    return known;
  }
  if (/^(?:hf|huggingface):/iu.test(source)) {
    return await resolveHuggingFaceArtifact(source, signal);
  }
  if (/^https:\/\//iu.test(source)) {
    const url = new URL(source);
    const fileName = path.basename(decodeURIComponent(url.pathname));
    if (!fileName.toLowerCase().includes(".gguf")) {
      throw new Error(`Remote model URL must name a GGUF file: ${source}`);
    }
    return { fileName, url: source };
  }
  throw new Error(`Unsupported remote model URI: ${source}`);
}

export async function ensureLlamaCppModel(params: {
  source: string;
  cacheDir: string;
  download: boolean;
  signal?: AbortSignal;
  onProgress?: LlamaDownloadProgress;
}): Promise<string> {
  const localSource = resolveHomePath(params.source);
  if (!/^(?:hf|huggingface|https):/iu.test(localSource)) {
    const localPath = path.isAbsolute(localSource)
      ? localSource
      : path.resolve(params.cacheDir, localSource);
    await assertGguf(localPath);
    return localPath;
  }
  const artifactCacheKey = `${path.resolve(params.cacheDir)}\0${localSource}`;
  const artifact =
    resolvedModelArtifacts.get(artifactCacheKey) ??
    (await resolveModelArtifact(localSource, params.signal));
  resolvedModelArtifacts.set(artifactCacheKey, artifact);
  const destination = path.join(params.cacheDir, artifact.fileName);
  const load =
    modelPromises.get(destination) ??
    (async () => {
      const exists = await fsp
        .stat(destination)
        .then((stat) => stat.isFile())
        .catch(() => false);
      if (
        exists &&
        artifact.expectedSha256 &&
        (await sha256File(destination, params.signal)) === artifact.expectedSha256
      ) {
        return destination;
      }
      if (exists && !artifact.expectedSha256) {
        await assertGguf(destination);
        return destination;
      }
      if (!params.download) {
        throw new Error(`Model is not cached at ${destination}`);
      }
      await downloadVerifiedFile({
        url: artifact.url,
        destination,
        expectedSha256: artifact.expectedSha256,
        expectedSize: artifact.expectedSize,
        requireServerDigest: !artifact.expectedSha256,
        signal: params.signal,
        onProgress: params.onProgress,
      });
      await assertGguf(destination);
      return destination;
    })();
  modelPromises.set(destination, load);
  try {
    return await load;
  } finally {
    if (modelPromises.get(destination) === load) {
      modelPromises.delete(destination);
    }
  }
}

function assertIniValue(value: string, label: string): string {
  if (/\r|\n/u.test(value)) {
    throw new Error(`${label} cannot contain a newline`);
  }
  return value;
}

function renderChatModelSection(params: {
  id: string;
  path: string;
  contextSize?: number;
  maxTokens?: number;
}): string {
  const id = assertIniValue(params.id, "llama.cpp model id");
  if (id.includes("]")) {
    throw new Error("llama.cpp model ids cannot contain ]");
  }
  return [
    `[${id}]`,
    `model = ${assertIniValue(params.path, "llama.cpp model path")}`,
    `ctx-size = ${params.contextSize ?? DEFAULT_LLAMA_CPP_CONTEXT_SIZE}`,
    `n-predict = ${params.maxTokens ?? 2048}`,
    "jinja = true",
  ].join("\n");
}

function renderEmbeddingModelSection(params: { isDefault?: boolean; modelPath: string }): string {
  return [
    `[${DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID}]`,
    `model = ${assertIniValue(params.modelPath, "llama.cpp embedding model path")}`,
    ...(params.isDefault ? [`ubatch-size = ${LLAMA_CPP_EMBEDDING_UBATCH_SIZE}`] : []),
    "embedding = true",
  ].join("\n");
}

function readModelSections(contents: string | undefined): Map<string, string> {
  const sections = new Map<string, string>();
  for (const block of contents?.split(/(?=^\[[^\]]+\]$)/mu) ?? []) {
    const match = /^\[([^\]]+)\]$/mu.exec(block);
    if (match) {
      sections.set(match[1]!, block.slice(match.index).trimEnd());
    }
  }
  return sections;
}

function renderLlamaServerPreset(params: {
  chatSections: Map<string, string>;
  embeddingSection: string;
}): string {
  return [
    "version = 1",
    "",
    ...[...params.chatSections]
      .toSorted(([left], [right]) => Number(left > right) - Number(left < right))
      .flatMap(([, section]) => [section, ""]),
    params.embeddingSection,
    "",
  ].join("\n");
}

async function writePreset(presetPath: string, contents: string): Promise<void> {
  await fsp.mkdir(path.dirname(presetPath), { recursive: true });
  const temporary = `${presetPath}.tmp-${randomUUID()}`;
  try {
    await fsp.writeFile(temporary, contents, { mode: 0o600 });
    await fsp.rename(temporary, presetPath);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}

async function runPresetTransition(run: () => Promise<void>): Promise<void> {
  const pending = presetState.transition.catch(() => undefined).then(run);
  presetState.transition = pending;
  await pending;
}

async function updatePreset(
  presetPath: string,
  params: {
    chatModel: ManagedLlamaChatModel;
    configuredChatModelIds?: readonly string[];
    embeddingModelIsDefault?: boolean;
    embeddingModelPath?: string;
    defaultEmbeddingModelPath?: string;
    reconcileOrigin?: string;
  },
): Promise<void> {
  await runPresetTransition(async () => {
    const existing = await fsp.readFile(presetPath, "utf8").catch((error: unknown) => {
      if (asOptionalRecord(error)?.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    const existingSections = readModelSections(existing);
    const embedding = existingSections.get(DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID);
    const configuredIds = params.configuredChatModelIds
      ? new Set(params.configuredChatModelIds)
      : undefined;
    const sections = new Map(
      [...existingSections].filter(
        ([id]) =>
          id !== DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID &&
          params.chatModel.mode !== "remove" &&
          (!configuredIds || configuredIds.has(id)),
      ),
    );
    if (params.chatModel.mode === "configure") {
      sections.set(params.chatModel.id, renderChatModelSection(params.chatModel));
    }
    const embeddingSection = params.embeddingModelPath
      ? renderEmbeddingModelSection({
          isDefault: params.embeddingModelIsDefault,
          modelPath: params.embeddingModelPath,
        })
      : (embedding ??
        (params.defaultEmbeddingModelPath
          ? renderEmbeddingModelSection({
              isDefault: true,
              modelPath: params.defaultEmbeddingModelPath,
            })
          : undefined));
    if (!embeddingSection) {
      throw new Error("llama.cpp embedding model path is required for a new managed preset");
    }
    const next = renderLlamaServerPreset({ chatSections: sections, embeddingSection });
    if (next !== existing) {
      await writePreset(presetPath, next);
    }
    if (params.reconcileOrigin) {
      // A revision becomes applied only after b10534 acknowledges reload; failures stay dirty.
      presetState.desiredRevisions.set(params.reconcileOrigin, `${presetPath}\0${next}`);
    }
  });
}

export async function reconcileManagedLlamaServer(params: {
  baseUrl: string;
  signal?: AbortSignal;
}): Promise<void> {
  await runPresetTransition(async () => {
    const origin = new URL(params.baseUrl).origin;
    const revision = presetState.desiredRevisions.get(origin);
    if (!revision || presetState.appliedRevisions.get(origin) === revision) {
      return;
    }
    const { response, release } = await fetchConfiguredLocalOriginWithSsrFGuard({
      url: `${origin}/models?reload=1`,
      configuredLocalOriginBaseUrl: origin,
      policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(origin),
      signal: params.signal,
      timeoutMs: LLAMA_CPP_PRESET_RELOAD_TIMEOUT_MS,
      auditContext: "llama-server-preset-reload",
    });
    try {
      if (!response.ok) {
        throw new Error(`llama.cpp preset reload failed: HTTP ${response.status}`);
      }
      presetState.appliedRevisions.set(origin, revision);
    } finally {
      await release();
    }
  });
}

async function findAvailableLlamaServerPort(preferred = LLAMA_CPP_DEFAULT_PORT): Promise<number> {
  const tryPort = async (port: number): Promise<number | undefined> =>
    await new Promise((resolve) => {
      const server = net.createServer();
      server.unref();
      server.once("error", () => resolve(undefined));
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        const selected = typeof address === "object" && address ? address.port : undefined;
        server.close(() => resolve(selected));
      });
    });
  return (
    (await tryPort(preferred)) ??
    (await tryPort(0)) ??
    Promise.reject(new Error("No loopback port is available for llama-server"))
  );
}

export async function prepareManagedLlamaServer(params: {
  // Runtime embedding refreshes preserve chat. Explicit embedding-only setup removes it.
  chatModel: ManagedLlamaChatModel;
  configuredChatModelIds?: readonly string[];
  embeddingModelIsDefault?: boolean;
  embeddingModelPath?: string;
  defaultEmbeddingModelPath?: string;
  port?: number;
  reconcileBaseUrl?: string;
  localService?: ModelProviderConfig["localService"];
  asset?: LlamaServerAsset;
  isolated?: boolean;
  signal?: AbortSignal;
  onProgress?: LlamaDownloadProgress;
}): Promise<ManagedLlamaServer> {
  params.signal?.throwIfAborted();
  const command =
    params.localService?.command ??
    (
      await ensureLlamaServerInstalled({
        asset: params.asset,
        signal: params.signal,
        onProgress: params.onProgress,
      })
    ).command;
  const port = params.port ?? (await findAvailableLlamaServerPort(params.isolated ? 0 : undefined));
  const rootUrl = `http://127.0.0.1:${port}`;
  const reconcileOrigin = params.reconcileBaseUrl
    ? new URL(params.reconcileBaseUrl).origin
    : rootUrl;
  const endpoint = {
    command,
    baseUrl: `${rootUrl}/v1`,
    healthUrl: params.localService?.healthUrl ?? `${rootUrl}/health`,
  };
  const configuredPreset =
    params.localService?.args?.find((_, index, args) => args[index - 1] === "--models-preset") ??
    params.localService?.env?.LLAMA_ARG_MODELS_PRESET;
  // Existing services may own a direct --model command instead of a router preset.
  // Keep that public localService contract; only setup creates a new router.
  if (params.localService && !configuredPreset && !params.isolated) {
    await runPresetTransition(async () => {
      presetState.desiredRevisions.delete(reconcileOrigin);
      presetState.appliedRevisions.delete(reconcileOrigin);
    });
    return { ...endpoint, args: params.localService.args ?? [] };
  }
  const defaultPreset = configuredPreset
    ? path.resolve(params.localService?.cwd ?? process.cwd(), configuredPreset)
    : resolveManagedLlamaServerPaths(params.asset).presetPath;
  // Setup candidates own their preset. Verification must never rewrite the active
  // server's restart configuration before the candidate is accepted.
  const presetPath = params.isolated
    ? path.join(path.dirname(defaultPreset), `models-${randomUUID()}.ini`)
    : defaultPreset;
  await updatePreset(presetPath, {
    chatModel: params.chatModel,
    configuredChatModelIds: params.configuredChatModelIds,
    embeddingModelIsDefault: params.embeddingModelIsDefault,
    embeddingModelPath: params.embeddingModelPath,
    defaultEmbeddingModelPath: params.defaultEmbeddingModelPath,
    reconcileOrigin: params.isolated ? undefined : reconcileOrigin,
  });
  params.signal?.throwIfAborted();
  return {
    ...endpoint,
    args:
      params.localService && !params.isolated
        ? (params.localService.args ?? [])
        : [
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--models-preset",
            presetPath,
            "--models-max",
            "2",
            "--metrics",
            "--no-ui",
          ],
  };
}

export async function ensureManagedLlamaServerForChat(params: {
  provider: ModelProviderConfig;
  model: {
    id: string;
    params?: Record<string, unknown>;
    contextTokens?: number;
    maxTokens?: number;
  };
}): Promise<void> {
  if (!params.provider.localService || !params.provider.baseUrl) {
    return;
  }
  const cacheDir = resolveLlamaCppModelCacheDir(params.provider);
  let chatModelPath = resolveCachedLlamaCppModelPath({
    model: params.model,
    provider: params.provider,
  });
  if (!chatModelPath && resolveLlamaCppModelSource(params.model) === DEFAULT_LLAMA_CPP_MODEL_URI) {
    const legacy = path.join(
      resolveLegacyLlamaCppModelCacheDir(),
      DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE,
    );
    if (
      await fsp
        .stat(legacy)
        .then((stat) => stat.isFile())
        .catch(() => false)
    ) {
      chatModelPath = legacy;
    }
  }
  chatModelPath = await ensureLlamaCppModel({
    source: chatModelPath ?? resolveLlamaCppModelSource(params.model),
    cacheDir,
    download: false,
  });
  const configuredContext = params.model.params?.contextSize;
  const port = Number(new URL(params.provider.baseUrl).port);
  await prepareManagedLlamaServer({
    chatModel: {
      mode: "configure",
      id: params.model.id,
      path: chatModelPath,
      contextSize:
        typeof configuredContext === "number" && configuredContext > 0
          ? Math.floor(configuredContext)
          : params.model.contextTokens,
      maxTokens: params.model.maxTokens,
    },
    configuredChatModelIds: params.provider.models.map((model) => model.id),
    defaultEmbeddingModelPath: path.join(cacheDir, DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE),
    port: Number.isInteger(port) && port > 0 ? port : undefined,
    reconcileBaseUrl: params.provider.baseUrl,
    localService: params.provider.localService,
  });
}

async function fetchEndpoint(
  url: string,
  accept: "json" | "text",
): Promise<{ ok: boolean; value?: unknown }> {
  try {
    const configuredLocalOriginBaseUrl = new URL(url).origin;
    const { response, release } = await fetchConfiguredLocalOriginWithSsrFGuard({
      url,
      configuredLocalOriginBaseUrl,
      policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(configuredLocalOriginBaseUrl),
      timeoutMs: 2_500,
      auditContext: "llama-server-inspect",
    });
    try {
      if (!response.ok) {
        return { ok: false };
      }
      const value =
        accept === "json"
          ? await readProviderJsonResponse(response, "llama-server inspection")
          : await readProviderTextResponse(response, "llama-server inspection");
      return { ok: true, value };
    } finally {
      await release();
    }
  } catch {
    return { ok: false };
  }
}

export async function inspectLlamaServerRuntime(params: {
  baseUrl: string;
  modelId: string;
  backend?: LlamaServerAsset["backend"];
  loadError?: string;
}): Promise<LlamaServerRuntimeFacts> {
  const root = params.baseUrl.replace(/\/v1\/?$/u, "").replace(/\/+$/u, "");
  const query = `model=${encodeURIComponent(params.modelId)}&autoload=false`;
  const [health, models, props, metrics] = await Promise.all([
    fetchEndpoint(`${root}/health`, "json"),
    fetchEndpoint(`${root}/models`, "json"),
    fetchEndpoint(`${root}/props?${query}`, "json"),
    fetchEndpoint(`${root}/metrics?${query}`, "text"),
  ]);
  const propsRecord = asOptionalRecord(props.value);
  const modalities = asOptionalRecord(propsRecord?.modalities);
  const modelsRecord = asOptionalRecord(models.value);
  const modelRows = Array.isArray(modelsRecord?.data) ? modelsRecord.data : [];
  const selected = modelRows
    .map((row) => asOptionalRecord(row))
    .find((row) => row?.id === params.modelId);
  const pathValue =
    typeof propsRecord?.model_path === "string"
      ? propsRecord.model_path
      : typeof selected?.path === "string"
        ? selected.path
        : undefined;
  return {
    engine: "llama.cpp",
    state:
      health.ok && models.ok && props.ok && metrics.ok && !params.loadError ? "ready" : "failed",
    backend: params.backend,
    buildInfo: typeof propsRecord?.build_info === "string" ? propsRecord.build_info : undefined,
    model: { id: params.modelId, ...(pathValue ? { path: pathValue } : {}) },
    capabilities: {
      vision: modalities?.vision === true,
      // OpenClaw does not configure a draft model in the managed preset.
      draft: false,
    },
    endpoints: {
      health: health.ok ? "ready" : "unavailable",
      models: models.ok ? "ready" : "unavailable",
      props: props.ok ? "ready" : "unavailable",
      metrics: metrics.ok ? "ready" : "unavailable",
    },
    ...(params.loadError ? { loadError: params.loadError } : {}),
  };
}
