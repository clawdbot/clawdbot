import { setGlobalDispatcher, EnvHttpProxyAgent } from "undici";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("infra/proxy");

/**
 * Configures the global undici dispatcher to respect standard proxy environment variables:
 * - HTTP_PROXY / http_proxy
 * - HTTPS_PROXY / https_proxy
 * - NO_PROXY / no_proxy
 *
 * This affects all global fetch() calls and undici-based requests.
 */
export function configureGlobalProxy(): void {
  const hasProxyEnv =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;

  if (!hasProxyEnv) {
    return;
  }

  try {
    // EnvHttpProxyAgent is the industry-standard way in undici to handle env-based proxies.
    // It automatically manages the logic for NO_PROXY and selecting the right proxy per protocol.
    const agent = new EnvHttpProxyAgent();
    setGlobalDispatcher(agent);

    // We don't log the full proxy URL by default to avoid leaking potential credentials
    // but we log that the proxy system is active.
    log.info("global proxy dispatcher initialized via environment variables");
  } catch (err) {
    // If proxy configuration fails, we log it but don't crash the app.
    // Standard behavior is to fallback to direct connection if possible.
    log.error(
      `failed to initialize global proxy dispatcher: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
