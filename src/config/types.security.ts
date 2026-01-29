export type SecurityConfig = {
  /**
   * If true, hardens the configuration for strictly local usage.
   * - Disables update checks on start.
   * - Disables diagnostics.
   * - Clears model fallbacks.
   * - Denies external tools (web_search, web_fetch, browser).
   * - Enforces Docker network isolation for sandboxes.
   * - Refuses to use cloud-based model providers.
   */
  strictLocal?: boolean;
};
