/**
 * Network proxy module — public API surface.
 *
 * This module routes OpenClaw process HTTP and WebSocket traffic through an
 * operator-managed filtering forward proxy. The proxy must enforce
 * destination filtering at connect time; OpenClaw only owns process-wide
 * routing into that proxy.
 *
 * Integration:
 *   1. Call startProxy(config?.proxy) early in protected daemon/CLI startup.
 *   2. Subsequent normal HTTP and WebSocket egress routes through the
 *      configured operator proxy.
 *   3. On shutdown, call stopProxy(handle).
 *
 * Fail-closed behavior:
 *   If proxy.enabled=true but no valid proxy URL is configured, or activation
 *   fails, protected commands must fail startup instead of falling back to
 *   direct network access.
 */

export { startProxy, stopProxy } from "./proxy-lifecycle.js";
export type { ProxyHandle } from "./proxy-lifecycle.js";

export { ProxyConfigSchema } from "../../../config/zod-schema.proxy.js";
export type { ProxyConfig } from "../../../config/zod-schema.proxy.js";
