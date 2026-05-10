import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { AcpRuntimeError, withAcpRuntimeErrorBoundary } from "../runtime/errors.js";
import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
} from "../runtime/types.js";
import type { SessionAcpMeta } from "./manager.types.js";
import { createUnsupportedControlError } from "./manager.utils.js";
import type { CachedRuntimeState } from "./runtime-cache.js";
import {
  buildRuntimeConfigOptionPairs,
  buildRuntimeControlSignature,
  normalizeText,
  resolveRuntimeOptionsFromMeta,
} from "./runtime-options.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractConfigOptionKeys(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return normalizeText(entry);
      }
      const record = asRecord(entry);
      return normalizeText(record?.id ?? record?.key);
    })
    .filter(Boolean) as string[];
}

function extractRuntimeStatusConfigOptionKeys(status: AcpRuntimeStatus | undefined): string[] {
  const details = asRecord(status?.details);
  return [
    ...extractConfigOptionKeys(details?.configOptions),
    ...extractConfigOptionKeys(details?.config_options),
  ];
}

export async function resolveManagerRuntimeCapabilities(params: {
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  includeStatusConfigOptionKeys?: boolean;
}): Promise<AcpRuntimeCapabilities> {
  let reported: AcpRuntimeCapabilities | undefined;
  if (params.runtime.getCapabilities) {
    reported = await withAcpRuntimeErrorBoundary({
      run: async () => await params.runtime.getCapabilities!({ handle: params.handle }),
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "Could not read ACP runtime capabilities.",
    });
  }
  const controls = new Set<AcpRuntimeCapabilities["controls"][number]>(reported?.controls ?? []);
  if (params.runtime.setMode) {
    controls.add("session/set_mode");
  }
  if (params.runtime.setConfigOption) {
    controls.add("session/set_config_option");
  }
  if (params.runtime.getStatus) {
    controls.add("session/status");
  }
  const normalizedKeys = new Set(
    (reported?.configOptionKeys ?? [])
      .map((entry) => normalizeText(entry))
      .filter(Boolean) as string[],
  );
  if (
    normalizedKeys.size === 0 &&
    params.includeStatusConfigOptionKeys &&
    params.runtime.getStatus
  ) {
    try {
      const status = await params.runtime.getStatus({ handle: params.handle });
      for (const key of extractRuntimeStatusConfigOptionKeys(status)) {
        normalizedKeys.add(key);
      }
    } catch {
      // Status-derived option keys are an optional refinement. Keep the
      // capability result usable for runtimes that expose controls but cannot
      // answer status before a turn.
    }
  }
  return {
    controls: [...controls].toSorted(),
    ...(normalizedKeys.size > 0 ? { configOptionKeys: [...normalizedKeys] } : {}),
  };
}

export async function applyManagerRuntimeControls(params: {
  sessionKey: string;
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  meta: SessionAcpMeta;
  getCachedRuntimeState: (sessionKey: string) => CachedRuntimeState | null;
}): Promise<void> {
  const options = resolveRuntimeOptionsFromMeta(params.meta);
  const signature = buildRuntimeControlSignature(options);
  const cached = params.getCachedRuntimeState(params.sessionKey);
  if (cached?.appliedControlSignature === signature) {
    return;
  }

  const needsConfigOptionKeys = buildRuntimeConfigOptionPairs(options).length > 0;
  const capabilities = await resolveManagerRuntimeCapabilities({
    runtime: params.runtime,
    handle: params.handle,
    includeStatusConfigOptionKeys: needsConfigOptionKeys,
  });
  const backend = params.handle.backend || params.meta.backend;
  const runtimeMode = normalizeText(options.runtimeMode);
  const configOptions = buildRuntimeConfigOptionPairs(options, capabilities.configOptionKeys);
  const advertisedKeys = new Set(
    (capabilities.configOptionKeys ?? [])
      .map((entry) => normalizeLowercaseStringOrEmpty(entry))
      .filter(Boolean),
  );

  await withAcpRuntimeErrorBoundary({
    run: async () => {
      if (runtimeMode) {
        if (!capabilities.controls.includes("session/set_mode") || !params.runtime.setMode) {
          throw createUnsupportedControlError({
            backend,
            control: "session/set_mode",
          });
        }
        await params.runtime.setMode({
          handle: params.handle,
          mode: runtimeMode,
        });
      }

      if (configOptions.length > 0) {
        if (
          !capabilities.controls.includes("session/set_config_option") ||
          !params.runtime.setConfigOption
        ) {
          throw createUnsupportedControlError({
            backend,
            control: "session/set_config_option",
          });
        }
        for (const [key, value] of configOptions) {
          if (
            advertisedKeys.size > 0 &&
            !advertisedKeys.has(normalizeLowercaseStringOrEmpty(key))
          ) {
            throw new AcpRuntimeError(
              "ACP_BACKEND_UNSUPPORTED_CONTROL",
              `ACP backend "${backend}" does not accept config key "${key}".`,
            );
          }
          await params.runtime.setConfigOption({
            handle: params.handle,
            key,
            value,
          });
        }
      }
    },
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not apply ACP runtime options before turn execution.",
  });

  if (cached) {
    cached.appliedControlSignature = signature;
  }
}
