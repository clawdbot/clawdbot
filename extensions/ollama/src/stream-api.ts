import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

export {
  createConfiguredOllamaCompatStreamWrapper,
  isOllamaCompatProvider,
  resolveOllamaCompatNumCtxEnabled,
  shouldInjectOllamaCompatNumCtx,
  wrapOllamaCompatNumCtx,
} from "./stream-compat.js";

type OllamaStreamRuntime = typeof import("./stream.runtime.js");

const loadOllamaStreamRuntime = createLazyRuntimeModule(() => import("./stream.runtime.js"));
const ollamaStreamRuntime = await loadOllamaStreamRuntime();

export const OLLAMA_NATIVE_BASE_URL: OllamaStreamRuntime["OLLAMA_NATIVE_BASE_URL"] =
  ollamaStreamRuntime.OLLAMA_NATIVE_BASE_URL;
export const resolveOllamaBaseUrlForRun: OllamaStreamRuntime["resolveOllamaBaseUrlForRun"] =
  ollamaStreamRuntime.resolveOllamaBaseUrlForRun;
export const buildOllamaChatRequest: OllamaStreamRuntime["buildOllamaChatRequest"] =
  ollamaStreamRuntime.buildOllamaChatRequest;
export const convertToOllamaMessages: OllamaStreamRuntime["convertToOllamaMessages"] =
  ollamaStreamRuntime.convertToOllamaMessages;
export const buildAssistantMessage: OllamaStreamRuntime["buildAssistantMessage"] =
  ollamaStreamRuntime.buildAssistantMessage;
export const parseNdjsonStream: OllamaStreamRuntime["parseNdjsonStream"] =
  ollamaStreamRuntime.parseNdjsonStream;
export const createOllamaStreamFn: OllamaStreamRuntime["createOllamaStreamFn"] =
  ollamaStreamRuntime.createOllamaStreamFn;
export const createConfiguredOllamaStreamFn: OllamaStreamRuntime["createConfiguredOllamaStreamFn"] =
  ollamaStreamRuntime.createConfiguredOllamaStreamFn;
