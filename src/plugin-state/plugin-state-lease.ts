// Plugin validation and public errors wrap the host-owned SQLite lease engine.
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import {
  OpenClawStateLeaseError,
  type OpenClawStateLeaseErrorCode,
  withOpenClawStateLease,
} from "../state/openclaw-state-lease.js";
import {
  PluginStateLeaseError,
  type PluginStateLeaseContext,
  type PluginStateLeaseErrorCode,
  type PluginStateLeaseOptions,
} from "./plugin-state-lease.types.js";
import { validatePluginStoreKey, validatePluginStoreNamespace } from "./plugin-store-validation.js";

const MIN_LEASE_MS = 1_000;

function leaseError(
  code: PluginStateLeaseErrorCode,
  message: string,
  cause?: unknown,
): PluginStateLeaseError {
  return new PluginStateLeaseError(message, { code, ...(cause === undefined ? {} : { cause }) });
}

function invalidInput(message: string): PluginStateLeaseError {
  return leaseError("PLUGIN_STATE_LEASE_INVALID_INPUT", message);
}

function validateDuration(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalidInput(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validatePluginId(pluginId: string): string {
  const normalized = pluginId.trim();
  if (!normalized || normalized.startsWith("core:") || normalized.includes("\0")) {
    throw invalidInput("plugin lease requires a non-core plugin id");
  }
  return normalized;
}

function validateOptions(pluginId: string, options: PluginStateLeaseOptions) {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw invalidInput("plugin lease options must be an object");
  }
  if (typeof options.namespace !== "string") {
    throw invalidInput("plugin lease namespace must be a string");
  }
  if (typeof options.key !== "string") {
    throw invalidInput("plugin lease key must be a string");
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw invalidInput("plugin lease signal must be an AbortSignal");
  }
  const errors = {
    invalid: (message: string) => invalidInput(message),
    limit: (message: string) => invalidInput(message),
  };
  const namespace = validatePluginStoreNamespace({
    value: options.namespace,
    label: "plugin lease",
    errors,
  });
  const key = validatePluginStoreKey({
    value: options.key,
    label: "plugin lease",
    errors,
  });
  const leaseMs = validateDuration(
    options.leaseMs,
    "plugin lease leaseMs",
    MIN_LEASE_MS,
    MAX_TIMER_TIMEOUT_MS,
  );
  const waitMs = validateDuration(options.waitMs, "plugin lease waitMs", 0, MAX_TIMER_TIMEOUT_MS);
  const database = options.database;
  if (typeof database !== "object" || database === null || Array.isArray(database)) {
    throw invalidInput("plugin lease database must be an object");
  }
  if (database.scope !== "shared" && database.scope !== "agent") {
    throw invalidInput("plugin lease database scope must be shared or agent");
  }
  if (database.scope === "agent") {
    if (typeof database.agentId !== "string" || !database.agentId.trim()) {
      throw invalidInput("plugin lease agent database requires a string agentId");
    }
  }
  return {
    scope: `plugin:${validatePluginId(pluginId)}:${namespace}`,
    key,
    leaseMs,
    waitMs,
    database,
    signal: options.signal,
  };
}

function mapErrorCode(code: OpenClawStateLeaseErrorCode): PluginStateLeaseErrorCode {
  switch (code) {
    case "OPENCLAW_STATE_LEASE_INVALID_INPUT":
      return "PLUGIN_STATE_LEASE_INVALID_INPUT";
    case "OPENCLAW_STATE_LEASE_TIMEOUT":
      return "PLUGIN_STATE_LEASE_TIMEOUT";
    case "OPENCLAW_STATE_LEASE_ABORTED":
      return "PLUGIN_STATE_LEASE_ABORTED";
    case "OPENCLAW_STATE_LEASE_LOST":
      return "PLUGIN_STATE_LEASE_LOST";
    case "OPENCLAW_STATE_LEASE_STORAGE_FAILED":
      return "PLUGIN_STATE_LEASE_STORAGE_FAILED";
    default:
      throw new Error(`unsupported OpenClaw state lease error code: ${String(code)}`);
  }
}

function mapLeaseError(error: unknown): unknown {
  if (!(error instanceof OpenClawStateLeaseError)) {
    return error;
  }
  return leaseError(mapErrorCode(error.code), error.message, error.cause);
}

function mapLeaseSignal(signal: AbortSignal): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(mapLeaseError(signal.reason));
  if (signal.aborted) {
    forwardAbort();
  } else {
    signal.addEventListener("abort", forwardAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => signal.removeEventListener("abort", forwardAbort),
  };
}

/** Run one trusted plugin operation under a host-owned SQLite lease. */
export async function withPluginStateLease<T>(
  pluginId: string,
  options: PluginStateLeaseOptions,
  run: (lease: PluginStateLeaseContext) => Promise<T>,
): Promise<T> {
  const validated = validateOptions(pluginId, options);
  try {
    return await withOpenClawStateLease(
      {
        ...validated,
        leaseLabel: "plugin lease",
        operationLabel: "plugin-state.lease",
      },
      async (lease) => {
        const mapped = mapLeaseSignal(lease.signal);
        try {
          return await run({
            signal: mapped.signal,
            assertOwned: () => {
              try {
                lease.assertOwned();
              } catch (error) {
                throw mapLeaseError(error);
              }
            },
          });
        } finally {
          mapped.dispose();
        }
      },
    );
  } catch (error) {
    throw mapLeaseError(error);
  }
}
