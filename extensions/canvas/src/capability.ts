/**
 * Canvas capability-token helpers for scoped hosted node URLs.
 */
import {
  buildPluginNodeCapabilityScopedHostUrl,
  DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS,
  mintPluginNodeCapabilityToken,
  normalizePluginNodeCapabilityScopedUrl,
  PLUGIN_NODE_CAPABILITY_PATH_PREFIX,
  type NormalizedPluginNodeCapabilityUrl,
} from "openclaw/plugin-sdk/gateway-runtime";

/** Path prefix used for Canvas capability-scoped gateway routes. */
export const CANVAS_CAPABILITY_PATH_PREFIX = PLUGIN_NODE_CAPABILITY_PATH_PREFIX;
/** Default Canvas capability token TTL in milliseconds. */
export const CANVAS_CAPABILITY_TTL_MS = DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS;

/** Normalized Canvas capability-scoped URL shape. */
type NormalizedCanvasScopedUrl = NormalizedPluginNodeCapabilityUrl;

/** Creates a new opaque Canvas capability token. */
export function mintCanvasCapabilityToken(): string {
  return mintPluginNodeCapabilityToken();
}

/** Builds a Canvas host URL scoped by the supplied capability token. */
export function buildCanvasScopedHostUrl(baseUrl: string, capability: string): string | undefined {
  return buildPluginNodeCapabilityScopedHostUrl(baseUrl, capability);
}

/** Normalizes and validates a Canvas capability-scoped URL. */
export function normalizeCanvasScopedUrl(rawUrl: string): NormalizedCanvasScopedUrl {
  return normalizePluginNodeCapabilityScopedUrl(rawUrl);
}
