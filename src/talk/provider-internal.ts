/**
 * Process-private realtime provider hooks for bundled implementations.
 *
 * The symbol keeps browser-only lifecycle and context handling out of the
 * public Plugin SDK. External providers continue to implement only the stable
 * RealtimeVoiceProviderPlugin contract.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type {
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceProviderCapabilities,
  RealtimeVoiceProviderConfig,
} from "./provider-types.js";

const INTERNAL_REALTIME_VOICE_PROVIDER = Symbol.for("openclaw.internal.realtime-voice-provider.v1");

export type InternalRealtimeVoiceProviderCapabilities = RealtimeVoiceProviderCapabilities & {
  /** The provider owns agent delegation instead of exposing client-side function tools. */
  handlesAgentConsult?: boolean;
};

export type InternalRealtimeVoiceBrowserSessionCreateRequest =
  RealtimeVoiceBrowserSessionCreateRequest & {
    agentId: string;
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
    /** Effective per-session model after request overrides. */
    model?: string;
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
  model?: string;
}): InternalRealtimeVoiceProviderCapabilities | undefined {
  return readInternalRealtimeVoiceProviderApi(params.provider)?.resolveBrowserSessionCapabilities?.(
    {
      cfg: params.cfg,
      providerConfig: params.providerConfig,
      model: params.model,
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
