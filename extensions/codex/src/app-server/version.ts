/**
 * Version and package pins for the managed Codex app-server runtime.
 */
// The supported range tracks protocol shapes validated against the managed
// package. Raising the ceiling requires regenerating schemas from that tag.
/** Minimum Codex app-server version supported by the OpenClaw Codex bridge. */
export const MIN_CODEX_APP_SERVER_VERSION = "0.143.0";
/** Newest Codex app-server version validated by the OpenClaw Codex bridge. */
export const MAX_CODEX_APP_SERVER_VERSION = "0.144.5";
/** npm package name for the managed Codex app-server binary. */
export const MANAGED_CODEX_APP_SERVER_PACKAGE = "@openai/codex";
