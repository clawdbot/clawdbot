import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { fetchConfiguredLocalOriginWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime-internal";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_LLAMA_CPP_CONTEXT_SIZE,
  DEFAULT_LLAMA_CPP_EMBEDDING_CONTEXT_SIZE,
  DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_REVISION,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_SHA256,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_SIZE_BYTES,
  DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE,
  DEFAULT_LLAMA_CPP_MODEL_ID,
  DEFAULT_LLAMA_CPP_MODEL_REVISION,
  DEFAULT_LLAMA_CPP_MODEL_SHA256,
  DEFAULT_LLAMA_CPP_MODEL_SIZE_BYTES,
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

type ModelArtifact = {
  source: string;
  fileName: string;
  url: string;
  expectedSize?: number;
  expectedSha256?: string;
};

export type ManagedLlamaServer = {
  command: string;
  presetPath: string;
  baseUrl: string;
  healthUrl: string;
  args: string[];
  backend: LlamaServerAsset["backend"];
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
const chatPreparationPromises = new Map<string, Promise<void>>();

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
      const ggufFile = asOptionalRecord(asOptionalRecord(await response.json())?.ggufFile);
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
  const treeUrl = `https://huggingface.co/api/models/${encodeURIComponent(parsed.user)}/${encodeURIComponent(parsed.repository)}/tree/${encodeURIComponent(parsed.revision)}?recursive=true&expand=true`;
  const { response: treeResponse, release: releaseTree } = await fetchWithSsrFGuard({
    url: treeUrl,
    signal,
    requireHttps: true,
    policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(treeUrl),
    auditContext: "llama-cpp-model-resolve",
  });
  let tree: unknown;
  try {
    if (!treeResponse.ok) {
      throw new Error(
        `Cannot read Hugging Face integrity metadata for ${source}: HTTP ${treeResponse.status}`,
      );
    }
    tree = await treeResponse.json();
  } finally {
    await releaseTree();
  }
  const fileRow = Array.isArray(tree)
    ? tree.map((entry) => asOptionalRecord(entry)).find((entry) => entry?.path === file)
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
  return { source, fileName: safeName, url, expectedSize, expectedSha256 };
}

function defaultArtifact(source: string): ModelArtifact | undefined {
  if (source === DEFAULT_LLAMA_CPP_MODEL_URI) {
    return {
      source,
      fileName: DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE,
      url: `https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/${DEFAULT_LLAMA_CPP_MODEL_REVISION}/gemma-4-E4B-it-Q4_K_M.gguf?download=true`,
      expectedSize: DEFAULT_LLAMA_CPP_MODEL_SIZE_BYTES,
      expectedSha256: DEFAULT_LLAMA_CPP_MODEL_SHA256,
    };
  }
  if (source === DEFAULT_LLAMA_CPP_EMBEDDING_MODEL) {
    return {
      source,
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
    return { source, fileName, url: source };
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
  const artifact = await resolveModelArtifact(localSource, params.signal);
  const destination = path.join(params.cacheDir, artifact.fileName);
  const pending = modelPromises.get(destination);
  if (pending) {
    return await pending;
  }
  const load = (async () => {
    const exists = await fsp
      .stat(destination)
      .then((stat) => stat.isFile())
      .catch(() => false);
    if (exists) {
      if (artifact.expectedSha256) {
        if ((await sha256File(destination)) === artifact.expectedSha256) {
          return destination;
        }
      } else {
        await assertGguf(destination);
        return destination;
      }
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

function renderLlamaServerPreset(params: {
  chatModelId?: string;
  chatModelPath?: string;
  contextSize?: number;
  maxTokens?: number;
  embeddingModelId: string;
  embeddingModelPath: string;
}): string {
  const embeddingId = assertIniValue(params.embeddingModelId, "llama.cpp embedding model id");
  if (embeddingId.includes("]")) {
    throw new Error("llama.cpp model ids cannot contain ]");
  }
  const lines = ["version = 1", ""];
  if (params.chatModelId || params.chatModelPath) {
    if (!params.chatModelId || !params.chatModelPath) {
      throw new Error("llama.cpp chat model id and path must be provided together");
    }
    const chatId = assertIniValue(params.chatModelId, "llama.cpp model id");
    if (chatId.includes("]")) {
      throw new Error("llama.cpp model ids cannot contain ]");
    }
    lines.push(
      `[${chatId}]`,
      `model = ${assertIniValue(params.chatModelPath, "llama.cpp model path")}`,
      `ctx-size = ${params.contextSize ?? DEFAULT_LLAMA_CPP_CONTEXT_SIZE}`,
      `n-predict = ${params.maxTokens ?? 2048}`,
      "jinja = true",
      "",
    );
  }
  lines.push(
    `[${embeddingId}]`,
    `model = ${assertIniValue(params.embeddingModelPath, "llama.cpp embedding model path")}`,
    // Stanza-scoped: independent of the chat stanza's ctx-size. Never pass
    // --ctx-size on the router command line; CLI args override preset keys.
    `ctx-size = ${DEFAULT_LLAMA_CPP_EMBEDDING_CONTEXT_SIZE}`,
    "embedding = true",
    "",
  );
  return lines.join("\n");
}

async function writePreset(presetPath: string, contents: string): Promise<void> {
  await fsp.mkdir(path.dirname(presetPath), { recursive: true });
  const temporary = `${presetPath}.tmp-${randomUUID()}`;
  await fsp.writeFile(temporary, contents, { mode: 0o600 });
  await fsp.rename(temporary, presetPath);
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
  chatModelId?: string;
  chatModelPath?: string;
  contextSize?: number;
  maxTokens?: number;
  embeddingModelPath: string;
  port?: number;
}): Promise<ManagedLlamaServer> {
  const { command, asset } = await ensureLlamaServerInstalled();
  const { presetPath } = resolveManagedLlamaServerPaths(asset);
  await writePreset(
    presetPath,
    renderLlamaServerPreset({
      ...(params.chatModelPath
        ? {
            chatModelId: params.chatModelId ?? DEFAULT_LLAMA_CPP_MODEL_ID,
            chatModelPath: params.chatModelPath,
          }
        : {}),
      contextSize: params.contextSize,
      maxTokens: params.maxTokens,
      embeddingModelId: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID,
      embeddingModelPath: params.embeddingModelPath,
    }),
  );
  const port = params.port ?? (await findAvailableLlamaServerPort());
  const rootUrl = `http://127.0.0.1:${port}`;
  return {
    command,
    presetPath,
    baseUrl: `${rootUrl}/v1`,
    healthUrl: `${rootUrl}/health`,
    args: [
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
    backend: asset.backend,
  };
}

export async function ensureManagedLlamaServerForChat(params: {
  provider: import("openclaw/plugin-sdk/provider-model-shared").ModelProviderConfig;
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
  const key = JSON.stringify([
    params.provider.baseUrl,
    params.model.id,
    params.model.params,
    cacheDir,
  ]);
  const pending =
    chatPreparationPromises.get(key) ??
    (async () => {
      let chatModelPath = resolveCachedLlamaCppModelPath({
        model: params.model,
        provider: params.provider,
      });
      if (
        !chatModelPath &&
        resolveLlamaCppModelSource(params.model) === DEFAULT_LLAMA_CPP_MODEL_URI
      ) {
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
        chatModelId: params.model.id,
        chatModelPath,
        contextSize:
          typeof configuredContext === "number" && configuredContext > 0
            ? Math.floor(configuredContext)
            : params.model.contextTokens,
        maxTokens: params.model.maxTokens,
        embeddingModelPath: path.join(cacheDir, DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE),
        port: Number.isInteger(port) && port > 0 ? port : undefined,
      });
    })();
  chatPreparationPromises.set(key, pending);
  try {
    await pending;
  } catch (error) {
    if (chatPreparationPromises.get(key) === pending) {
      chatPreparationPromises.delete(key);
    }
    throw error;
  }
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
      return { ok: true, value: accept === "json" ? await response.json() : await response.text() };
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
