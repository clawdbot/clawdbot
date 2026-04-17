// Public runtime auth helpers for provider plugins.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export { resolveEnvApiKey } from "../agents/model-auth-env.js";
export {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
} from "../agents/api-key-rotation.js";
export { NON_ENV_SECRETREF_MARKER } from "../agents/model-auth-markers.js";
export {
  requireApiKey,
  resolveAwsSdkEnvVarName,
  type ResolvedProviderAuth,
} from "../agents/model-auth-runtime-shared.js";
export type { ProviderPreparedRuntimeAuth } from "../plugins/types.js";
export type { ResolvedProviderRuntimeAuth } from "../plugins/runtime/model-auth-types.js";

type ResolveApiKeyForProvider = typeof import("../agents/model-auth.js").resolveApiKeyForProvider;
type GetRuntimeAuthForModel =
  typeof import("../plugins/runtime/runtime-model-auth.runtime.js").getRuntimeAuthForModel;
type RuntimeModelAuthModule = typeof import("../plugins/runtime/runtime-model-auth.runtime.js");
const RUNTIME_MODEL_AUTH_CANDIDATES = [
  "./runtime-model-auth.runtime",
  "../plugins/runtime/runtime-model-auth.runtime",
] as const;
const RUNTIME_MODEL_AUTH_EXTENSIONS = [".js", ".ts", ".mjs", ".mts", ".cjs", ".cts"] as const;

function resolveRuntimeModelAuthModuleHref(): string {
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  for (const relativeBase of RUNTIME_MODEL_AUTH_CANDIDATES) {
    for (const ext of RUNTIME_MODEL_AUTH_EXTENSIONS) {
      const candidate = path.resolve(baseDir, `${relativeBase}${ext}`);
      if (fs.existsSync(candidate)) {
        return pathToFileURL(candidate).href;
      }
    }
  }
  throw new Error(`Unable to resolve runtime model auth module from ${import.meta.url}`);
}

async function loadRuntimeModelAuthModule(): Promise<RuntimeModelAuthModule> {
  return (await import(resolveRuntimeModelAuthModuleHref())) as RuntimeModelAuthModule;
}

export async function resolveApiKeyForProvider(
  params: Parameters<ResolveApiKeyForProvider>[0],
): Promise<Awaited<ReturnType<ResolveApiKeyForProvider>>> {
  const { resolveApiKeyForProvider } = await loadRuntimeModelAuthModule();
  return resolveApiKeyForProvider(params);
}

export async function getRuntimeAuthForModel(
  params: Parameters<GetRuntimeAuthForModel>[0],
): Promise<Awaited<ReturnType<GetRuntimeAuthForModel>>> {
  const { getRuntimeAuthForModel } = await loadRuntimeModelAuthModule();
  return getRuntimeAuthForModel(params);
}
