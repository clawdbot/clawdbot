import {
  buildPluginNodeCapabilityScopedHostUrl,
  DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS,
  mintPluginNodeCapabilityToken,
  normalizePluginNodeCapabilityScopedUrl,
  PLUGIN_NODE_CAPABILITY_PATH_PREFIX,
  type NormalizedPluginNodeCapabilityUrl,
} from "openclaw/plugin-sdk/gateway-runtime";

export const CANVAS_CAPABILITY_PATH_PREFIX = PLUGIN_NODE_CAPABILITY_PATH_PREFIX;
export const CANVAS_CAPABILITY_TTL_MS = DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS;

export type NormalizedCanvasScopedUrl = NormalizedPluginNodeCapabilityUrl;

export function mintCanvasCapabilityToken(): string {
  return mintPluginNodeCapabilityToken();
}

export function buildCanvasScopedHostUrl(baseUrl: string, capability: string): string | undefined {
  return buildPluginNodeCapabilityScopedHostUrl(baseUrl, capability);
}

export function normalizeCanvasScopedUrl(rawUrl: string): NormalizedCanvasScopedUrl {
  return normalizePluginNodeCapabilityScopedUrl(rawUrl);
}
