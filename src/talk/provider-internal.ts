/**
 * Process-private realtime provider hooks for bundled implementations.
 *
 * The symbol keeps browser-only lifecycle and context handling out of the
 * public Plugin SDK. External providers continue to implement only the stable
 * RealtimeVoiceProviderPlugin contract.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  RealtimeVoicePublicClientHints,
  RealtimeVoicePublicProjection,
} from "../plugins/provider-policy-surface.js";
import { resolveBundledProviderPolicySurface } from "../plugins/provider-public-artifacts.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type {
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceProviderCapabilities,
  RealtimeVoiceProviderConfig,
} from "./provider-types.js";

const INTERNAL_REALTIME_VOICE_PROVIDER = Symbol.for("openclaw.internal.realtime-voice-provider.v1");

export type InternalRealtimeVoiceProviderCapabilities = RealtimeVoiceProviderCapabilities & {
  /** Dynamic voice choices for the effective route without exposing its model identifier. */
  voices?: readonly string[];
  /** Treat absent configured voices as unsupported and fall back to the provider default. */
  voiceSelectionPolicy?: "allowlist-default";
  /** Model-specific voice choices; the provider's voices remain the default catalog. */
  voicesByModel?: Record<string, readonly string[]>;
  /** The provider owns agent delegation instead of exposing client-side function tools. */
  handlesAgentConsult?: boolean;
  /** The provider can keep browser media direct while exposing its control wire to Gateway. */
  supportsGatewayControl?: boolean;
};

export type InternalRealtimeVoiceBrowserSessionCreateRequest =
  RealtimeVoiceBrowserSessionCreateRequest & {
    agentId: string;
    ownerConnId?: string;
    workspaceDir: string;
    initialItems: Array<{
      role: "user" | "assistant";
      text: string;
    }>;
  };

type InternalRealtimeVoiceProviderApi = {
  isBrowserSessionConfigured: (ctx: {
    cfg?: OpenClawConfig;
    providerConfig: RealtimeVoiceProviderConfig;
    agentId?: string;
  }) => boolean;
  resolveBrowserSessionCapabilities?: (ctx: {
    cfg?: OpenClawConfig;
    providerConfig: RealtimeVoiceProviderConfig;
    agentId?: string;
    /** Effective per-session model after request overrides. */
    model?: string;
    clientControl?: RealtimeVoiceBrowserSessionCreateRequest["clientControl"];
  }) => InternalRealtimeVoiceProviderCapabilities;
  isGatewayRelayConfigured?: (ctx: {
    cfg?: OpenClawConfig;
    providerConfig: RealtimeVoiceProviderConfig;
    agentId?: string;
  }) => boolean | undefined;
  resolveGatewayRelayCapabilities?: (ctx: {
    cfg?: OpenClawConfig;
    providerConfig: RealtimeVoiceProviderConfig;
    model?: string;
  }) => InternalRealtimeVoiceProviderCapabilities;
  projectPublicProjection?: (ctx: {
    providerConfig: RealtimeVoiceProviderConfig;
    config: RealtimeVoiceProviderConfig;
  }) => RealtimeVoicePublicProjection;
  validateGatewayRelayLaunch?: (ctx: {
    cfg?: OpenClawConfig;
    providerConfig: RealtimeVoiceProviderConfig;
    model?: string;
    autoRespondToAudio?: boolean;
  }) => string | undefined;
  cancelBrowserSession?: (
    request: InternalRealtimeVoiceBrowserSessionCreateRequest,
    session: RealtimeVoiceBrowserSession,
  ) => Promise<void> | void;
};

function readInternalRealtimeVoiceProviderApi(
  provider: RealtimeVoiceProviderPlugin,
): InternalRealtimeVoiceProviderApi | undefined {
  const value = Reflect.get(provider, INTERNAL_REALTIME_VOICE_PROVIDER) as unknown;
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const api = value as Partial<InternalRealtimeVoiceProviderApi>;
  return typeof api.isBrowserSessionConfigured === "function"
    ? (api as InternalRealtimeVoiceProviderApi)
    : undefined;
}

export function isInternalRealtimeVoiceBrowserSessionConfigured(params: {
  provider: RealtimeVoiceProviderPlugin;
  cfg?: OpenClawConfig;
  providerConfig: RealtimeVoiceProviderConfig;
  agentId?: string;
}): boolean | undefined {
  return readInternalRealtimeVoiceProviderApi(params.provider)?.isBrowserSessionConfigured({
    cfg: params.cfg,
    providerConfig: params.providerConfig,
    agentId: params.agentId,
  });
}

export function resolveInternalRealtimeVoiceBrowserSessionCapabilities(params: {
  provider: RealtimeVoiceProviderPlugin;
  cfg?: OpenClawConfig;
  providerConfig: RealtimeVoiceProviderConfig;
  agentId?: string;
  model?: string;
  clientControl?: RealtimeVoiceBrowserSessionCreateRequest["clientControl"];
}): InternalRealtimeVoiceProviderCapabilities | undefined {
  return readInternalRealtimeVoiceProviderApi(params.provider)?.resolveBrowserSessionCapabilities?.(
    {
      cfg: params.cfg,
      providerConfig: params.providerConfig,
      agentId: params.agentId,
      model: params.model,
      ...(params.clientControl ? { clientControl: params.clientControl } : {}),
    },
  );
}

export function isInternalRealtimeVoiceGatewayRelayConfigured(params: {
  provider: RealtimeVoiceProviderPlugin;
  cfg?: OpenClawConfig;
  providerConfig: RealtimeVoiceProviderConfig;
  agentId?: string;
}): boolean | undefined {
  return readInternalRealtimeVoiceProviderApi(params.provider)?.isGatewayRelayConfigured?.({
    cfg: params.cfg,
    providerConfig: params.providerConfig,
    agentId: params.agentId,
  });
}

export function resolveInternalRealtimeVoiceGatewayRelayCapabilities(params: {
  provider: RealtimeVoiceProviderPlugin;
  cfg?: OpenClawConfig;
  providerConfig: RealtimeVoiceProviderConfig;
  model?: string;
}): InternalRealtimeVoiceProviderCapabilities | undefined {
  return readInternalRealtimeVoiceProviderApi(params.provider)?.resolveGatewayRelayCapabilities?.({
    cfg: params.cfg,
    providerConfig: params.providerConfig,
    model: params.model,
  });
}

export function projectInternalRealtimeVoicePublicConfig<
  T extends RealtimeVoiceProviderConfig,
>(params: {
  provider?: RealtimeVoiceProviderPlugin;
  providerId?: string;
  providerConfig: RealtimeVoiceProviderConfig;
  config: T;
}): T {
  return projectInternalRealtimeVoicePublicProjection(params).config;
}

export function projectInternalRealtimeVoicePublicProjection<
  T extends RealtimeVoiceProviderConfig,
>(params: {
  provider?: RealtimeVoiceProviderPlugin;
  providerId?: string;
  providerConfig: RealtimeVoiceProviderConfig;
  config: T;
}): { config: T; clientHints?: RealtimeVoicePublicClientHints } {
  const project =
    (params.provider
      ? readInternalRealtimeVoiceProviderApi(params.provider)?.projectPublicProjection
      : undefined) ??
    (params.providerId
      ? resolveBundledProviderPolicySurface(params.providerId)?.projectRealtimeVoicePublicProjection
      : undefined);
  const projected = project?.({ providerConfig: params.providerConfig, config: params.config });
  if (projected) {
    return {
      ...projected,
      // SAFETY: projections only remove or replace `model`; other fields stay intact.
      config: projected.config as T,
    };
  }
  return { config: params.config };
}

export function resolveInternalRealtimeVoiceGatewayRelayLaunchError(params: {
  provider: RealtimeVoiceProviderPlugin;
  cfg?: OpenClawConfig;
  providerConfig: RealtimeVoiceProviderConfig;
  model?: string;
  autoRespondToAudio?: boolean;
}): string | undefined {
  return readInternalRealtimeVoiceProviderApi(params.provider)?.validateGatewayRelayLaunch?.({
    cfg: params.cfg,
    providerConfig: params.providerConfig,
    model: params.model,
    autoRespondToAudio: params.autoRespondToAudio,
  });
}

export async function cancelInternalRealtimeVoiceBrowserSession(params: {
  provider: RealtimeVoiceProviderPlugin;
  request: InternalRealtimeVoiceBrowserSessionCreateRequest;
  session: RealtimeVoiceBrowserSession;
}): Promise<void> {
  await readInternalRealtimeVoiceProviderApi(params.provider)?.cancelBrowserSession?.(
    params.request,
    params.session,
  );
}
