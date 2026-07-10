/**
 * Version and package pins for the managed Codex app-server runtime.
 */
// The floor tracks the managed package train. Every protocol shape OpenClaw
// sends or reads assumes this floor; range-compat normalizers were removed
// with the 0.143 bump, so lowering it requires reintroducing them.
/** Minimum Codex app-server version supported by the OpenClaw Codex bridge. */
export const MIN_CODEX_APP_SERVER_VERSION = "0.143.0";
/** npm package name for the managed Codex app-server binary. */
export const MANAGED_CODEX_APP_SERVER_PACKAGE = "@openai/codex";
// Keep this in sync with the Codex CLI live-test package pin.
/** Managed Codex app-server package version installed by OpenClaw. */
export const MANAGED_CODEX_APP_SERVER_PACKAGE_VERSION = "0.144.1";
