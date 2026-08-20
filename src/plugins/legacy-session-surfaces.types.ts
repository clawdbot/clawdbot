import type { BundledChannelLegacySessionSurface } from "../plugin-sdk/channel-entry-contract.types.js";

export type PreparedLegacySessionSurfaces = Readonly<{
  surfaces: readonly BundledChannelLegacySessionSurface[];
  failures: readonly string[];
}>;

export const EMPTY_LEGACY_SESSION_SURFACES: PreparedLegacySessionSurfaces = Object.freeze({
  surfaces: Object.freeze([]),
  failures: Object.freeze([]),
});
