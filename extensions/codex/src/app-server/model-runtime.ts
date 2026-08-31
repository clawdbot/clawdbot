import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const CODEX_APP_SERVER_RUNTIME_MODEL_PARAM = "codexAppServerRuntimeModel";

type CodexRuntimeModel = {
  id: string;
  params?: Record<string, unknown>;
};

export function buildCodexRuntimeModelParams(catalogId: string, runtimeModelId: string) {
  return catalogId === runtimeModelId
    ? undefined
    : { [CODEX_APP_SERVER_RUNTIME_MODEL_PARAM]: runtimeModelId };
}

export function readCodexRuntimeModelId(
  model: CodexRuntimeModel | undefined,
  fallbackId: string,
): string {
  return (
    normalizeOptionalString(model?.params?.[CODEX_APP_SERVER_RUNTIME_MODEL_PARAM]) ??
    model?.id ??
    fallbackId
  );
}
