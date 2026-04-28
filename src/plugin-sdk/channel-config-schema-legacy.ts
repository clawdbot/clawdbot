/**
 * Deprecated bundled-channel compatibility surface.
 *
 * OpenClaw-maintained bundled plugins should import
 * openclaw/plugin-sdk/bundled-channel-config-schema. Third-party plugins should
 * define plugin-local schemas and import primitives from
 * openclaw/plugin-sdk/channel-config-schema instead of depending on bundled
 * channel schemas.
 */
export * from "./bundled-channel-config-schema.js";
