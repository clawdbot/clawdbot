import { onLlmRequestActivity } from "@openclaw/ai/internal/runtime";
/**
 * Wraps LLM streams with idle-timeout detection and diagnostics.
 */
import {
  finiteSecondsToTimerSafeMilliseconds,
  clampTimerTimeoutMs,
  MAX_TIMER_TIMEOUT_MS,
} from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { toErrorObject } from "../../../infra/errors.js";
import type { StreamFn } from "../../runtime/index.js";
import type { MutableAssistantMessageEventStream } from "../../stream-compat.js";
import { createStreamIteratorWrapper } from "../../stream-iterator-wrapper.js";
import type { EmbeddedRunTrigger } from "./params.js";

/**
 * Default idle timeout for LLM streaming responses in milliseconds.
 */
const DEFAULT_LLM_IDLE_TIMEOUT_MS = 120_000;
const SELF_HOSTED_LLM_IDLE_TIMEOUT_MS = 300_000;
const CLOUD_LLM_FIRST_EVENT_TIMEOUT_MS = DEFAULT_LLM_IDLE_TIMEOUT_MS;
const LOCAL_LLM_FIRST_EVENT_TIMEOUT_MS = 300_000;
// Cron has its own outer watchdog; stream stalls must fail early enough for
// the existing model fallback chain to try the next configured candidate.
const CRON_LLM_IDLE_TIMEOUT_MS = 60_000;
const LOCAL_PROVIDER_AUTH_MARKERS = new Set(["custom-local", "ollama-local"]);
const SELF_HOSTED_PROVIDER_ID_PREFIXES = ["ollama", "lmstudio", "vllm", "sglang", "llama-cpp"];

type IdleTimeoutProviderConfig = {
  apiKey?: unknown;
  localService?: unknown;
};

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
 *    hostname to a private IP) are not detected for the implicit watchdog opt-out:
 *    classification keys on `URL.hostname` so resolution would have to happen
 *    here, and adding sync/async DNS to the watchdog hot path is disproportionate.
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

function isExplicitLocalHostnameBaseUrl(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }

  if (
    host === "docker.orb.internal" ||
    host === "host.docker.internal" ||
    host === "host.orb.internal"
  ) {
    return true;
  }
  return false;
}

function isBareProviderHostnameBaseUrl(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }

  if (host.includes(".") || host.includes(":")) {
    return false;
  }
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host);
}

function isSelfHostedProviderId(provider: string | undefined): boolean {
  const normalized = provider?.trim().toLowerCase();
  if (!normalized || normalized === "ollama-cloud") {
    return false;
  }
  return SELF_HOSTED_PROVIDER_ID_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}-`),
  );
}

function findConfiguredProviderConfig(
  cfg: OpenClawConfig | undefined,
  provider: string | undefined,
): IdleTimeoutProviderConfig | undefined {
  const normalizedProvider = provider?.trim().toLowerCase();
  if (!normalizedProvider) {
    return undefined;
  }
  const providers = cfg?.models?.providers as
    | Record<string, IdleTimeoutProviderConfig | undefined>
    | undefined;
  const exact = providers?.[normalizedProvider];
  if (exact) {
    return exact;
  }
  return Object.entries(providers ?? {}).find(
    ([key]) => key.trim().toLowerCase() === normalizedProvider,
  )?.[1];
}

function hasLocalProviderAuthMarker(apiKey: unknown): boolean {
  return typeof apiKey === "string" && LOCAL_PROVIDER_AUTH_MARKERS.has(apiKey.trim().toLowerCase());
}

function hasConfiguredLocalProviderSignal(params: {
  cfg: OpenClawConfig | undefined;
  provider: string | undefined;
}): boolean {
  const providerConfig = findConfiguredProviderConfig(params.cfg, params.provider);
  return Boolean(
    providerConfig?.localService || hasLocalProviderAuthMarker(providerConfig?.apiKey),
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

type RuntimeModelLocality = {
  isLocalRuntimeModel: boolean;
  isExplicitLocalHostnameRuntimeModel: boolean;
  isSelfHostedHostnameRuntimeModel: boolean;
};

/**
 * Classifies the model endpoint locality shared by the idle and first-event
 * watchdogs. Ollama `*:cloud` models stay "cloud" even behind a local proxy.
 */
function resolveRuntimeModelLocality(params?: {
  cfg?: OpenClawConfig;
  model?: { baseUrl?: string; id?: string; provider?: string };
}): RuntimeModelLocality {
  const baseUrl = params?.model?.baseUrl;
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    return {
      isLocalRuntimeModel: false,
      isExplicitLocalHostnameRuntimeModel: false,
      isSelfHostedHostnameRuntimeModel: false,
    };
  }
  const notCloudModel = !isOllamaCloudModel(params?.model);
  return {
    isLocalRuntimeModel: isLocalProviderBaseUrl(baseUrl) && notCloudModel,
    isExplicitLocalHostnameRuntimeModel: isExplicitLocalHostnameBaseUrl(baseUrl) && notCloudModel,
    isSelfHostedHostnameRuntimeModel:
      isBareProviderHostnameBaseUrl(baseUrl) &&
      (isSelfHostedProviderId(params?.model?.provider) ||
        hasConfiguredLocalProviderSignal({
          cfg: params?.cfg,
          provider: params?.model?.provider,
        })) &&
      notCloudModel,
  };
}

/**
 * Resolves the stream-idle watchdog timeout for one embedded run. Explicit
 * provider request timeouts and bounded run/agent timeouts cap the watchdog;
 * local provider base URLs disable the implicit cloud-provider default.
 */
export function resolveLlmIdleTimeoutMs(params?: {
  cfg?: OpenClawConfig;
  trigger?: EmbeddedRunTrigger;
  runTimeoutMs?: number;
  modelRequestTimeoutMs?: number;
  model?: { baseUrl?: string; id?: string; provider?: string };
}): number {
  const clampTimeoutMs = (valueMs: number) => clampTimerTimeoutMs(valueMs) ?? 1;

  const runTimeoutMs = params?.runTimeoutMs;
  const agentTimeoutSeconds = params?.cfg?.agents?.defaults?.timeoutSeconds;
  const agentTimeoutMs = finiteSecondsToTimerSafeMilliseconds(agentTimeoutSeconds);
  const hasExplicitRunTimeout =
    typeof runTimeoutMs === "number" && Number.isFinite(runTimeoutMs) && runTimeoutMs > 0;
  const runTimeoutIsNoTimeout = hasExplicitRunTimeout && runTimeoutMs >= MAX_TIMER_TIMEOUT_MS;
  const {
    isLocalRuntimeModel,
    isExplicitLocalHostnameRuntimeModel,
    isSelfHostedHostnameRuntimeModel,
  } = resolveRuntimeModelLocality(params);
  const isSelfHostedRuntimeModel =
    isSelfHostedProviderId(params?.model?.provider) && !isOllamaCloudModel(params?.model);
  const timeoutBounds = [
    runTimeoutIsNoTimeout ? undefined : runTimeoutMs,
    hasExplicitRunTimeout ? undefined : agentTimeoutMs,
  ].filter(
    (value): value is number =>
      typeof value === "number" &&
      Number.isFinite(value) &&
      value > 0 &&
      value < MAX_TIMER_TIMEOUT_MS,
  );

  // Run/agent budgets bound idle from below the provider-class ceiling; they
  // must not shrink class tolerance (local has no ceiling, self-hosted 300s).
  // Clamping every class to the cloud default reopened #85826-style kills for
  // self-hosted users with explicit budgets above 120s.
  const clampToClassIdleCeiling = (budgetMs: number): number => {
    if (isLocalRuntimeModel) {
      return clampTimeoutMs(budgetMs);
    }
    const classIdleTimeoutMs =
      isSelfHostedRuntimeModel ||
      isExplicitLocalHostnameRuntimeModel ||
      isSelfHostedHostnameRuntimeModel
        ? SELF_HOSTED_LLM_IDLE_TIMEOUT_MS
        : DEFAULT_LLM_IDLE_TIMEOUT_MS;
    return clampTimeoutMs(Math.min(budgetMs, classIdleTimeoutMs));
  };

  // Explicit per-model idle timeout (`models.providers.<id>.timeoutSeconds`) wins
  // over the NO_TIMEOUT_MS sentinel that runTimeoutMs may carry when the caller
  // declared "run is unlimited". The two are independent: an unlimited run does
  // not imply opting out of chunk-level hang detection.
  const modelRequestTimeoutMs = params?.modelRequestTimeoutMs;
  if (
    typeof modelRequestTimeoutMs === "number" &&
    Number.isFinite(modelRequestTimeoutMs) &&
    modelRequestTimeoutMs > 0
  ) {
    // `modelRequestTimeoutMs` is wired from `models.providers.<id>.timeoutSeconds`,
    // which is an explicit per-provider opt-in. The schema help describes it as
    // "Use this for slow local or self-hosted model servers instead of changing
    // global agent timeouts." so we honor it as a deliberate ceiling rather
    // than clamping it back down to the implicit `DEFAULT_LLM_IDLE_TIMEOUT_MS`
    // network-silence-as-hang guard. Without this, users hitting #77744 /
    // #78361 set provider timeoutSeconds to e.g. 600s, observe the value is
    // accepted and hot-reloaded, yet the idle watchdog still aborts at 120s.
    // The agent/run timeoutBounds still apply so an explicit shorter run
    // timeout always wins.
    const boundedTimeoutMs = Math.min(modelRequestTimeoutMs, ...timeoutBounds);
    return clampTimeoutMs(boundedTimeoutMs);
  }

  // Unlimited run budget bounds total cost, not stream liveness. Only finite
  // explicit run budgets cap the idle watchdog.
  if (hasExplicitRunTimeout && runTimeoutMs < MAX_TIMER_TIMEOUT_MS) {
    if (params?.trigger === "cron") {
      if (
        isLocalRuntimeModel ||
        isExplicitLocalHostnameRuntimeModel ||
        isSelfHostedHostnameRuntimeModel ||
        isSelfHostedRuntimeModel
      ) {
        return clampTimeoutMs(runTimeoutMs);
      }
      return clampTimeoutMs(Math.min(runTimeoutMs, CRON_LLM_IDLE_TIMEOUT_MS));
    }
    return clampToClassIdleCeiling(runTimeoutMs);
  }

  if (agentTimeoutMs !== undefined) {
    return clampToClassIdleCeiling(agentTimeoutMs);
  }

  // The default watchdog is a network-silence-as-hang guard for cloud providers.
  // Local providers can legitimately stream nothing for many minutes during
  // prompt evaluation or thinking, so falling back to the default would abort
  // valid local runs. Honor it only when the user has not opted out via the
  // baseUrl pointing at loopback / private-network / `.local`. Ollama cloud
  // models are still hosted remotely even when proxied through local Ollama, so
  // keep the cloud watchdog for `*:cloud` model ids.
  if (isLocalRuntimeModel) {
    return 0;
  }

  if (
    isSelfHostedRuntimeModel ||
    isExplicitLocalHostnameRuntimeModel ||
    isSelfHostedHostnameRuntimeModel
  ) {
    return SELF_HOSTED_LLM_IDLE_TIMEOUT_MS;
  }

  return DEFAULT_LLM_IDLE_TIMEOUT_MS;
}

export function resolveLlmFirstEventTimeoutMs(params?: {
  cfg?: OpenClawConfig;
  runTimeoutMs?: number;
  modelRequestTimeoutMs?: number;
  model?: { baseUrl?: string; id?: string; provider?: string };
}): number {
  const clampTimeoutMs = (valueMs: number) => clampTimerTimeoutMs(valueMs) ?? 1;
  const runTimeoutMs = params?.runTimeoutMs;
  const agentTimeoutMs = finiteSecondsToTimerSafeMilliseconds(
    params?.cfg?.agents?.defaults?.timeoutSeconds,
  );
  const hasExplicitRunTimeout =
    typeof runTimeoutMs === "number" && Number.isFinite(runTimeoutMs) && runTimeoutMs > 0;
  const runTimeoutIsBounded = hasExplicitRunTimeout && runTimeoutMs < MAX_TIMER_TIMEOUT_MS;
  const {
    isLocalRuntimeModel,
    isExplicitLocalHostnameRuntimeModel,
    isSelfHostedHostnameRuntimeModel,
  } = resolveRuntimeModelLocality(params);
  const isSelfHostedRuntimeModel =
    isSelfHostedProviderId(params?.model?.provider) && !isOllamaCloudModel(params?.model);
  const timeoutBounds = [
    // Unlimited run budget bounds total cost, not first-token liveness. Omit
    // the sentinel from bounds so provider-class defaults still apply.
    runTimeoutIsBounded ? runTimeoutMs : undefined,
    hasExplicitRunTimeout ? undefined : agentTimeoutMs,
  ].filter(
    (value): value is number =>
      typeof value === "number" &&
      Number.isFinite(value) &&
      value > 0 &&
      value < MAX_TIMER_TIMEOUT_MS,
  );

  const modelRequestTimeoutMs = params?.modelRequestTimeoutMs;
  if (
    typeof modelRequestTimeoutMs === "number" &&
    Number.isFinite(modelRequestTimeoutMs) &&
    modelRequestTimeoutMs > 0
  ) {
    return clampTimeoutMs(Math.min(modelRequestTimeoutMs, ...timeoutBounds));
  }

  const defaultTimeoutMs =
    isLocalRuntimeModel ||
    isExplicitLocalHostnameRuntimeModel ||
    isSelfHostedHostnameRuntimeModel ||
    isSelfHostedRuntimeModel
      ? LOCAL_LLM_FIRST_EVENT_TIMEOUT_MS
      : CLOUD_LLM_FIRST_EVENT_TIMEOUT_MS;
  return clampTimeoutMs(Math.min(defaultTimeoutMs, ...timeoutBounds));
}

/**
 * Wraps a stream function with idle timeout detection for both stream creation
 * and iterator progress. Each successful `next()` resets the timer; a timeout
 * aborts the provider request and surfaces the same Error to the caller.
 * `scope: "creation-only"` bounds only the creation phase: local providers opt
 * out of gap policing, but a request whose headers never arrive must still fail
 * instead of wedging the turn until the run budget.
 */
export function streamWithIdleTimeout(
  baseFn: StreamFn,
  timeoutMs: number,
  onIdleTimeout?: (error: Error) => void,
  opts?: { scope?: "creation-and-gaps" | "creation-only" },
): StreamFn {
  const guardIterationGaps = opts?.scope !== "creation-only";
  return (model, context, options) => {
    const createIdleTimeoutError = () =>
      new Error(`LLM idle timeout (${Math.floor(timeoutMs / 1000)}s): no response from model`);

    const streamAbortController = new AbortController();
    const sourceSignal = options?.signal;
    const abortStream = (reason?: unknown) => {
      if (!streamAbortController.signal.aborted) {
        streamAbortController.abort(reason);
      }
    };
    const abortFromSourceSignal = () => abortStream(sourceSignal?.reason);
    // Mirror caller cancellation into the provider request while still allowing
    // this wrapper to abort independently on idle timeout.
    if (sourceSignal?.aborted) {
      abortFromSourceSignal();
    } else {
      sourceSignal?.addEventListener("abort", abortFromSourceSignal, { once: true });
    }
    const cleanupSourceSignal = () => {
      sourceSignal?.removeEventListener("abort", abortFromSourceSignal);
    };
    const wrappedOptions = {
      ...options,
      signal: streamAbortController.signal,
    } as typeof options;
    const createTimeoutPromise = (setTimer: (timer: NodeJS.Timeout) => void): Promise<never> => {
      return new Promise((_, reject) => {
        const timer = setTimeout(() => {
          const error = createIdleTimeoutError();
          abortStream(error);
          onIdleTimeout?.(error);
          reject(error);
        }, timeoutMs);
        timer.unref?.();
        setTimer(timer);
      });
    };

    let maybeStream: ReturnType<StreamFn>;
    try {
      maybeStream = baseFn(model, context, wrappedOptions);
    } catch (error) {
      cleanupSourceSignal();
      throw error;
    }

    const wrapStream = (stream: MutableAssistantMessageEventStream) => {
      const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
      (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
        function () {
          const iterator = originalAsyncIterator();
          let idleTimer: NodeJS.Timeout | null = null;
          let waitingForProvider = false;
          let rejectIdleTimeout: ((error: Error) => void) | undefined;

          const clearTimer = () => {
            if (idleTimer) {
              clearTimeout(idleTimer);
              idleTimer = null;
            }
          };
          const armTimer = () => {
            clearTimer();
            if (!guardIterationGaps || !waitingForProvider) {
              return;
            }
            idleTimer = setTimeout(() => {
              idleTimer = null;
              const error = createIdleTimeoutError();
              abortStream(error);
              onIdleTimeout?.(error);
              rejectIdleTimeout?.(error);
            }, timeoutMs);
            idleTimer.unref?.();
          };
          const stopWaiting = () => {
            waitingForProvider = false;
            rejectIdleTimeout = undefined;
            clearTimer();
          };
          const unsubscribeActivity = onLlmRequestActivity(streamAbortController.signal, armTimer);
          const cleanupIterator = () => {
            stopWaiting();
            unsubscribeActivity();
            cleanupSourceSignal();
          };

          return createStreamIteratorWrapper({
            iterator,
            next: async (streamIterator) => {
              waitingForProvider = true;
              try {
                const timeoutPromise = new Promise<never>((_, reject) => {
                  rejectIdleTimeout = reject;
                  armTimer();
                });
                const result = await Promise.race([streamIterator.next(), timeoutPromise]);

                if (result.done) {
                  cleanupIterator();
                  return result;
                }

                stopWaiting();
                return result;
              } catch (error) {
                cleanupIterator();
                throw error;
              }
            },
            onReturn(streamIterator) {
              cleanupIterator();
              return streamIterator.return?.() ?? Promise.resolve({ done: true, value: undefined });
            },
            onThrow(streamIterator, error) {
              cleanupIterator();
              return (
                streamIterator.throw?.(error) ??
                Promise.reject(toErrorObject(error, "Non-Error rejection"))
              );
            },
          });
        };

      return stream;
    };

    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      let streamPromiseTimer: NodeJS.Timeout | null = null;
      const clearStreamPromiseTimer = () => {
        if (streamPromiseTimer) {
          clearTimeout(streamPromiseTimer);
          streamPromiseTimer = null;
        }
      };

      // Some providers return a pending Promise before the stream object exists;
      // protect that creation phase with the same idle watchdog.
      return Promise.race([
        Promise.resolve(maybeStream),
        createTimeoutPromise((timer) => {
          streamPromiseTimer = timer;
        }),
      ]).then(
        (stream) => {
          clearStreamPromiseTimer();
          return wrapStream(stream);
        },
        (error: unknown) => {
          clearStreamPromiseTimer();
          cleanupSourceSignal();
          throw error;
        },
      );
    }
    return wrapStream(maybeStream);
  };
}
