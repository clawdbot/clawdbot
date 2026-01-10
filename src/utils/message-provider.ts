import {
  listChatProviderAliases,
  normalizeChatProviderId,
  PROVIDER_IDS,
} from "../providers/registry.js";

export const INTERNAL_MESSAGE_PROVIDER = "webchat" as const;
export type InternalMessageProvider = typeof INTERNAL_MESSAGE_PROVIDER;

export const GATEWAY_CLIENT_NAMES = {
  WEBCHAT_UI: "webchat-ui",
  CONTROL_UI: "clawdbot-control-ui",
  WEBCHAT: "webchat",
  CLI: "cli",
  GATEWAY_CLIENT: "gateway-client",
  TEST: "test",
  FINGERPRINT: "fingerprint",
  PROBE: "clawdbot-probe",
} as const;

export type GatewayClientName =
  (typeof GATEWAY_CLIENT_NAMES)[keyof typeof GATEWAY_CLIENT_NAMES];

export const GATEWAY_CLIENT_MODES = {
  WEBCHAT: "webchat",
  CLI: "cli",
  UI: "ui",
  BACKEND: "backend",
  PROBE: "probe",
  TEST: "test",
} as const;

export type GatewayClientMode =
  (typeof GATEWAY_CLIENT_MODES)[keyof typeof GATEWAY_CLIENT_MODES];

type GatewayClientInfo = { mode?: string | null; name?: string | null };

const GATEWAY_CLIENT_NAME_SET = new Set<GatewayClientName>(
  Object.values(GATEWAY_CLIENT_NAMES),
);
const GATEWAY_CLIENT_MODE_SET = new Set<GatewayClientMode>(
  Object.values(GATEWAY_CLIENT_MODES),
);

export function normalizeGatewayClientName(
  raw?: string | null,
): GatewayClientName | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return undefined;
  return GATEWAY_CLIENT_NAME_SET.has(normalized as GatewayClientName)
    ? (normalized as GatewayClientName)
    : undefined;
}

export function normalizeGatewayClientMode(
  raw?: string | null,
): GatewayClientMode | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return undefined;
  return GATEWAY_CLIENT_MODE_SET.has(normalized as GatewayClientMode)
    ? (normalized as GatewayClientMode)
    : undefined;
}

export function isGatewayCliClient(client?: GatewayClientInfo | null): boolean {
  return normalizeGatewayClientMode(client?.mode) === GATEWAY_CLIENT_MODES.CLI;
}

export function isInternalMessageProvider(raw?: string | null): boolean {
  return normalizeMessageProvider(raw) === INTERNAL_MESSAGE_PROVIDER;
}

export function isWebchatClient(client?: GatewayClientInfo | null): boolean {
  const mode = normalizeGatewayClientMode(client?.mode);
  if (mode === GATEWAY_CLIENT_MODES.WEBCHAT) return true;
  return (
    normalizeGatewayClientName(client?.name) === GATEWAY_CLIENT_NAMES.WEBCHAT_UI
  );
}

export function normalizeMessageProvider(
  raw?: string | null,
): string | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === INTERNAL_MESSAGE_PROVIDER)
    return INTERNAL_MESSAGE_PROVIDER;
  return normalizeChatProviderId(normalized) ?? normalized;
}

export const DELIVERABLE_MESSAGE_PROVIDERS = PROVIDER_IDS;

export type DeliverableMessageProvider =
  (typeof DELIVERABLE_MESSAGE_PROVIDERS)[number];

export type GatewayMessageProvider =
  | DeliverableMessageProvider
  | InternalMessageProvider;

export const GATEWAY_MESSAGE_PROVIDERS = [
  ...DELIVERABLE_MESSAGE_PROVIDERS,
  INTERNAL_MESSAGE_PROVIDER,
] as const;

export const GATEWAY_AGENT_PROVIDER_ALIASES = listChatProviderAliases();

export type GatewayAgentProviderHint = GatewayMessageProvider | "last";

export const GATEWAY_AGENT_PROVIDER_VALUES = Array.from(
  new Set([
    ...GATEWAY_MESSAGE_PROVIDERS,
    "last",
    ...GATEWAY_AGENT_PROVIDER_ALIASES,
  ]),
);

export function isGatewayMessageProvider(
  value: string,
): value is GatewayMessageProvider {
  return (GATEWAY_MESSAGE_PROVIDERS as readonly string[]).includes(value);
}

export function isDeliverableMessageProvider(
  value: string,
): value is DeliverableMessageProvider {
  return (DELIVERABLE_MESSAGE_PROVIDERS as readonly string[]).includes(value);
}

export function resolveGatewayMessageProvider(
  raw?: string | null,
): GatewayMessageProvider | undefined {
  const normalized = normalizeMessageProvider(raw);
  if (!normalized) return undefined;
  return isGatewayMessageProvider(normalized) ? normalized : undefined;
}

export function resolveMessageProvider(
  primary?: string | null,
  fallback?: string | null,
): string | undefined {
  return (
    normalizeMessageProvider(primary) ?? normalizeMessageProvider(fallback)
  );
}
