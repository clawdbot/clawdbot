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
  }) => boolean;
  resolveBrowserSessionCapabilities?: (ctx: {
    cfg?: OpenClawConfig;
    providerConfig: RealtimeVoiceProviderConfig;
  }) => InternalRealtimeVoiceProviderCapabilities;
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
}): boolean {
  return (
    readInternalRealtimeVoiceProviderApi(params.provider)?.isBrowserSessionConfigured({
      cfg: params.cfg,
      providerConfig: params.providerConfig,
    }) === true
  );
}

export function resolveInternalRealtimeVoiceBrowserSessionCapabilities(params: {
  provider: RealtimeVoiceProviderPlugin;
  cfg?: OpenClawConfig;
  providerConfig: RealtimeVoiceProviderConfig;
}): InternalRealtimeVoiceProviderCapabilities | undefined {
  return readInternalRealtimeVoiceProviderApi(params.provider)?.resolveBrowserSessionCapabilities?.(
    {
      cfg: params.cfg,
      providerConfig: params.providerConfig,
    },
  );
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
