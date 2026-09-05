import type { ConfigReplaceResult } from "../config/mutate.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getActivePluginRegistryVersion } from "./runtime.js";

export const getPluginRuntimeGeneration = getActivePluginRegistryVersion;

export class PluginRuntimeApplicationError extends Error {
  constructor(
    message: string,
    readonly details: {
      operationId: string;
      generation: number;
      pluginIds: string[];
      phase: "prepare" | "drain" | "activate" | "dispose";
      committed: boolean;
    },
    options?: ErrorOptions,
  ) {
    super(
      `${message}\nGateway generation ${details.generation}: replacement ${details.committed ? "applied" : "not applied"}.`,
      options,
    );
    this.name = "PluginRuntimeApplicationError";
  }
}

/** A receipt describes the published runtime, never authority to invoke it. */
export type PluginRuntimeApplication = {
  operationId: string;
  generation: number;
  pluginIds: string[];
  sourceDigests?: Record<string, string>;
};

export type PluginLifecycleReason =
  | "install"
  | "enable"
  | "disable"
  | "uninstall"
  | "reload"
  | "metadata";

export type PluginLifecycleRuntimeApply = (params: {
  config: OpenClawConfig;
  write?: Pick<ConfigReplaceResult, "persistedHash" | "persistedSourceConfig">;
  pluginIds: readonly string[];
  reason: PluginLifecycleReason;
  /** Private invoker authority; never part of the published runtime receipt. */
  assertInvokerOwned?: () => void;
}) => Promise<PluginRuntimeApplication>;

/** Capture publications independently of later management or authority failures. */
export function capturePluginRuntimeApplications(applyRuntime: PluginLifecycleRuntimeApply) {
  let application: PluginRuntimeApplication | undefined;
  return {
    get application() {
      return application;
    },
    applyRuntime: async (params: Parameters<PluginLifecycleRuntimeApply>[0]) => {
      application = await applyRuntime(params);
      return application;
    },
  };
}

export function projectPluginRuntimeFailure(
  error: unknown,
  application?: PluginRuntimeApplication,
) {
  const attempt = error instanceof PluginRuntimeApplicationError ? error.details : undefined;
  // A later rejected replacement does not undo an earlier publication in this operation.
  const previous = application && !attempt?.committed ? application : undefined;
  return {
    message:
      formatErrorMessage(error) +
      (previous
        ? `\nAn earlier runtime change from this operation was applied in Gateway generation ${previous.generation}.`
        : ""),
    runtime: previous ? { ...previous, committed: true } : attempt,
    ...(previous && attempt ? { runtimeAttempt: attempt } : {}),
  };
}
