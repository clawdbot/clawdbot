import { FAILOVER_REASONS, type FailoverReason } from "../agents/failover/signal.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveLoadedProviderRuntimePlugin,
  resolveLoadedProviderPluginsForHooks,
} from "./provider-hook-runtime.js";
import type { ProviderFailoverErrorContext, ProviderPlugin } from "./types.js";

function isFailoverReason(value: unknown): value is FailoverReason {
  return typeof value === "string" && FAILOVER_REASONS.some((reason) => reason === value);
}

// Error handling consumes prepared runtime. Cold discovery here can stall the
// event loop while an unrelated provider is loaded just to describe a failure.
export function classifyProviderFailoverSignalWithPlugin(params: {
  provider?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderFailoverErrorContext;
}) {
  const plugins = resolveProviderPluginsForScopedHook(params);
  for (const plugin of plugins) {
    if (plugin.matchesContextOverflowError?.(params.context)) {
      return "context_overflow";
    }
    const reason: unknown = plugin.classifyFailoverReason?.(params.context);
    if (reason) {
      // Plugin results cross a runtime boundary; types do not validate external hooks.
      return isFailoverReason(reason) ? reason : undefined;
    }
  }
  return undefined;
}

function resolveProviderPluginsForScopedHook(params: {
  provider?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderFailoverErrorContext;
}): ProviderPlugin[] {
  if (!params.provider) {
    return resolveLoadedProviderPluginsForHooks(params) ?? [];
  }
  const plugin = resolveLoadedProviderRuntimePlugin({ ...params, provider: params.provider });
  if (plugin) {
    return [plugin];
  }
  if (hasStructuredFailoverDescriptor(params.context)) {
    return [];
  }
  // Descriptor-free custom routes can consult other loaded hooks, but unrelated
  // providers must not override structured HTTP/auth signals.
  return resolveLoadedProviderPluginsForHooks(params) ?? [];
}

function hasStructuredFailoverDescriptor(context: ProviderFailoverErrorContext): boolean {
  return (
    context.status !== undefined || context.code !== undefined || context.errorType !== undefined
  );
}
