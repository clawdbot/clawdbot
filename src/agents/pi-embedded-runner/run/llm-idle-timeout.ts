import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { DEFAULT_LLM_IDLE_TIMEOUT_SECONDS } from "../../../config/agent-timeout-defaults.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createStreamIteratorWrapper } from "../../stream-iterator-wrapper.js";
import type { EmbeddedRunTrigger } from "./params.js";

/**
 * Default idle timeout for LLM streaming responses in milliseconds.
 */
export const DEFAULT_LLM_IDLE_TIMEOUT_MS = DEFAULT_LLM_IDLE_TIMEOUT_SECONDS * 1000;

/**
 * Maximum safe timeout value (approximately 24.8 days).
 */
const MAX_SAFE_TIMEOUT_MS = 2_147_000_000;

/**
 * Detects loopback / private-network / `.local` base URLs. Local providers
 * (Ollama, LM Studio, llama.cpp) legitimately stay silent for many minutes
 * during prompt evaluation and thinking, so the network-silence-as-hang
 * heuristic that motivates the default idle watchdog does not apply.
 *
 * Coverage scope:
 *  - IPv4 loopback (RFC 5735, full 127/8), RFC 1918 private, RFC 6598 shared
 *    CGNAT (100.64/10 — Tailscale/Headscale IPv4 mesh), `0.0.0.0`, `localhost`,
 *    and `*.local` mDNS (RFC 6762).
 *  - IPv6 loopback `::1`, IPv6 unique local `fc00::/7` (RFC 4193 — Tailscale's
 *    IPv6 mesh `fd7a:115c:a1e0::/48` falls in this range), and IPv6 link-local
 *    `fe80::/10` (RFC 4291).
 *  - IPv4-mapped IPv6 covers loopback only (`::ffff:127.0.0.1`,
 *    `::ffff:7f00:1`); private IPv4 in mapped form is intentionally not
 *    matched, mirroring the SSRF-policy helper in
 *    `src/cron/isolated-agent/model-preflight.runtime.ts`.
 *  - DNS-resolved local aliases (e.g. an `/etc/hosts` entry mapping a custom
 *    hostname to a private IP) are not detected: classification keys on
 *    `URL.hostname` so resolution would have to happen here, and adding
 *    sync/async DNS to the watchdog hot path is disproportionate. Affected
 *    users can use the IP directly or set
 *    `models.providers.<id>.timeoutSeconds` explicitly.
 */
function isLocalProviderBaseUrl(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "::ffff:7f00:1" ||
    host === "::ffff:127.0.0.1" ||
    host.endsWith(".local")
  ) {
    return true;
  }
  // IPv6 unique local (RFC 4193, fc00::/7) and link-local (RFC 4291,
  // fe80::/10). The full first hextet is required so an abbreviated `fc::1`
  // (which expands to `00fc:0:0:...` and is therefore not in fc00::/7)
  // correctly stays on the cloud path. The first regex requires four hex
  // digits then a colon; a zone identifier such as `fe80::1%eth0` is fine
  // because the prefix still matches at the start.
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) {
    return true;
  }
  // Require a strict IPv4 literal before parsing; `Number.parseInt` is
  // permissive and would otherwise let `10.0.0.5evil` parse to [10,0,0,5]
  // and disable the watchdog for a non-IP hostname.
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return false;
  }
  const octets = host.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = octets;
  // RFC 5735 loopback (127/8 — full range, not just .0.1; container/sandbox
  // setups commonly bind 127.0.0.2+), RFC 1918 private IPv4, and RFC 6598
  // shared CGNAT (100.64/10 — used by Tailscale and similar mesh VPNs).
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b !== undefined && b >= 64 && b <= 127)
  );
}

function isOllamaCloudModel(model: { id?: string; provider?: string } | undefined): boolean {
  const rawModelId = model?.id;
  if (typeof rawModelId !== "string") {
    return false;
  }

  const provider = model?.provider?.trim().toLowerCase();
  if (provider && !provider.startsWith("ollama")) {
    return false;
  }

  const modelId = rawModelId.trim().toLowerCase();
  const slashIndex = modelId.indexOf("/");
  const bareModelId = slashIndex >= 0 ? modelId.slice(slashIndex + 1) : modelId;
  return bareModelId.endsWith(":cloud");
}

/**
 * Resolves the LLM idle timeout from configuration.
 * @returns Idle timeout in milliseconds, or 0 to disable
 */
export function resolveLlmIdleTimeoutMs(params?: {
  cfg?: OpenClawConfig;
  trigger?: EmbeddedRunTrigger;
  runTimeoutMs?: number;
  modelRequestTimeoutMs?: number;
  model?: { baseUrl?: string; id?: string; provider?: string };
}): number {
  const clampTimeoutMs = (valueMs: number) => Math.min(Math.floor(valueMs), MAX_SAFE_TIMEOUT_MS);
  const clampImplicitTimeoutMs = (valueMs: number) =>
    clampTimeoutMs(Math.min(valueMs, DEFAULT_LLM_IDLE_TIMEOUT_MS));

  const runTimeoutMs = params?.runTimeoutMs;
  if (typeof runTimeoutMs === "number" && Number.isFinite(runTimeoutMs) && runTimeoutMs > 0) {
    if (runTimeoutMs >= MAX_SAFE_TIMEOUT_MS) {
      return 0;
    }
  }

  const agentTimeoutSeconds = params?.cfg?.agents?.defaults?.timeoutSeconds;
  const agentTimeoutMs =
    typeof agentTimeoutSeconds === "number" &&
    Number.isFinite(agentTimeoutSeconds) &&
    agentTimeoutSeconds > 0
      ? agentTimeoutSeconds * 1000
      : undefined;
  const timeoutBounds = [runTimeoutMs, agentTimeoutMs].filter(
    (value): value is number =>
      typeof value === "number" &&
      Number.isFinite(value) &&
      value > 0 &&
      value < MAX_SAFE_TIMEOUT_MS,
  );

  const modelRequestTimeoutMs = params?.modelRequestTimeoutMs;
  if (
    typeof modelRequestTimeoutMs === "number" &&
    Number.isFinite(modelRequestTimeoutMs) &&
    modelRequestTimeoutMs > 0
  ) {
    return clampTimeoutMs(Math.min(modelRequestTimeoutMs, ...timeoutBounds));
  }

  if (typeof runTimeoutMs === "number" && Number.isFinite(runTimeoutMs) && runTimeoutMs > 0) {
    if (params?.trigger === "cron") {
      return clampTimeoutMs(runTimeoutMs);
    }
    return clampImplicitTimeoutMs(runTimeoutMs);
  }

  if (agentTimeoutMs !== undefined) {
    return clampImplicitTimeoutMs(agentTimeoutMs);
  }

  if (params?.trigger === "cron") {
    return 0;
  }

  // The default watchdog is a network-silence-as-hang guard for cloud providers.
  // Local providers can legitimately stream nothing for many minutes during
  // prompt evaluation or thinking, so falling back to the default would abort
  // valid local runs. Honor it only when the user has not opted out via the
  // baseUrl pointing at loopback / private-network / `.local`. Ollama cloud
  // models are still hosted remotely even when proxied through local Ollama, so
  // keep the cloud watchdog for `*:cloud` model ids.
  const baseUrl = params?.model?.baseUrl;
  if (
    typeof baseUrl === "string" &&
    baseUrl.length > 0 &&
    isLocalProviderBaseUrl(baseUrl) &&
    !isOllamaCloudModel(params?.model)
  ) {
    return 0;
  }

  return DEFAULT_LLM_IDLE_TIMEOUT_MS;
}

/**
 * Wraps a stream function with idle timeout detection.
 * If no token is received within the specified timeout, the request is aborted.
 *
 * @param baseFn - The base stream function to wrap
 * @param timeoutMs - Idle timeout in milliseconds
 * @param onIdleTimeout - Optional callback invoked when idle timeout triggers
 * @returns A wrapped stream function with idle timeout detection
 */
export function streamWithIdleTimeout(
  baseFn: StreamFn,
  timeoutMs: number,
  onIdleTimeout?: (error: Error) => void,
): StreamFn {
  return (model, context, options) => {
    const maybeStream = baseFn(model, context, options);

    const wrapStream = (stream: ReturnType<typeof streamSimple>) => {
      const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
      (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
        function () {
          const iterator = originalAsyncIterator();
          let idleTimer: NodeJS.Timeout | null = null;

          const createTimeoutPromise = (): Promise<never> => {
            return new Promise((_, reject) => {
              idleTimer = setTimeout(() => {
                const error = new Error(
                  `LLM idle timeout (${Math.floor(timeoutMs / 1000)}s): no response from model`,
                );
                onIdleTimeout?.(error);
                reject(error);
              }, timeoutMs);
            });
          };

          const clearTimer = () => {
            if (idleTimer) {
              clearTimeout(idleTimer);
              idleTimer = null;
            }
          };

          return createStreamIteratorWrapper({
            iterator,
            next: async (streamIterator) => {
              clearTimer();

              try {
                // Race between the actual next() and the timeout
                const result = await Promise.race([streamIterator.next(), createTimeoutPromise()]);

                if (result.done) {
                  clearTimer();
                  return result;
                }

                clearTimer();
                return result;
              } catch (error) {
                clearTimer();
                throw error;
              }
            },
            onReturn(streamIterator) {
              clearTimer();
              return streamIterator.return?.() ?? Promise.resolve({ done: true, value: undefined });
            },
            onThrow(streamIterator, error) {
              clearTimer();
              return streamIterator.throw?.(error) ?? Promise.reject(error);
            },
          });
        };

      return stream;
    };

    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then(wrapStream);
    }
    return wrapStream(maybeStream);
  };
}
