import {
  listChatProviderAliases,
  normalizeChatProviderId,
  PROVIDER_IDS,
} from "../providers/registry.js";

export const INTERNAL_MESSAGE_PROVIDER = "webchat" as const;
export type InternalMessageProvider = typeof INTERNAL_MESSAGE_PROVIDER;

export function isInternalMessageProvider(raw?: string | null): boolean {
  return normalizeMessageProvider(raw) === INTERNAL_MESSAGE_PROVIDER;
}

export function isWebchatClient(
  client?: { mode?: string; name?: string } | null,
): boolean {
  return isInternalMessageProvider(client?.mode) || client?.name === "webchat-ui";
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
