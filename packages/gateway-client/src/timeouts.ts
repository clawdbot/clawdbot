// Gateway Client module implements timeouts behavior.
function parseStrictPositiveInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\+?\d+$/u.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isTestRuntimeEnv(env: NodeJS.ProcessEnv): boolean {
  return (
    env.VITEST === "true" ||
    env.VITEST === "1" ||
    env.VITEST_POOL_ID !== undefined ||
    env.VITEST_WORKER_ID !== undefined ||
    env.NODE_ENV === "test" ||
    (env !== process.env &&
      (process.env.VITEST === "true" ||
        process.env.VITEST === "1" ||
        process.env.VITEST_POOL_ID !== undefined ||
        process.env.VITEST_WORKER_ID !== undefined ||
        process.env.NODE_ENV === "test"))
  );
}

/** Maximum delay Node timers can represent without overflow warnings. */
export const MAX_SAFE_TIMEOUT_DELAY_MS = 2_147_483_647;
/** Default server-side window for gateway preauth handshakes. */
export const DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 15_000;
/** Default deadline for a single non-streaming Gateway request. */
export const DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS = 30_000;
/** Minimum client watchdog delay for connect challenge setup. */
export const MIN_CONNECT_CHALLENGE_TIMEOUT_MS = 250;
/** Default maximum client watchdog delay, aligned with the preauth server timeout. */
export const MAX_CONNECT_CHALLENGE_TIMEOUT_MS = DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS;

/** Clamps arbitrary timer delays to Node's safe range and an optional floor. */
export function resolveSafeTimeoutDelayMs(delayMs: number, opts?: { minMs?: number }): number {
  const rawMinMs = opts?.minMs ?? 1;
  const minMs = Math.min(
    MAX_SAFE_TIMEOUT_DELAY_MS,
    Math.max(0, Number.isFinite(rawMinMs) ? Math.floor(rawMinMs) : 1),
  );
  const candidateMs = Number.isFinite(delayMs) ? Math.floor(delayMs) : minMs;
  return Math.min(MAX_SAFE_TIMEOUT_DELAY_MS, Math.max(minMs, candidateMs));
}

/** Adds grace time while preserving safe timer bounds if inputs overflow or are invalid. */
export function addSafeTimeoutDelayGraceMs(
  delayMs: number,
  graceMs: number,
  opts?: { minMs?: number },
): number {
  if (!Number.isFinite(delayMs) || !Number.isFinite(graceMs)) {
    return resolveSafeTimeoutDelayMs(MAX_SAFE_TIMEOUT_DELAY_MS, opts);
  }
  const withGrace = delayMs + graceMs;
  return resolveSafeTimeoutDelayMs(
    Number.isFinite(withGrace) ? withGrace : MAX_SAFE_TIMEOUT_DELAY_MS,
    opts,
  );
}

/** Resolves optional timeout values through a fallback and safe timer clamp. */
export function resolveFiniteTimeoutDelayMs(
  delayMs: number | null | undefined,
  fallbackMs: number,
  opts?: { minMs?: number },
): number {
  const candidateMs =
    typeof delayMs === "number" && Number.isFinite(delayMs) ? delayMs : fallbackMs;
  return resolveSafeTimeoutDelayMs(candidateMs, opts);
}

/** Clamps connect challenge watchdog timeouts to the gateway-supported range. */
export function clampConnectChallengeTimeoutMs(
  timeoutMs: number,
  maxTimeoutMs = MAX_CONNECT_CHALLENGE_TIMEOUT_MS,
): number {
  return Math.max(
    MIN_CONNECT_CHALLENGE_TIMEOUT_MS,
    Math.min(Math.max(MIN_CONNECT_CHALLENGE_TIMEOUT_MS, maxTimeoutMs), timeoutMs),
  );
}

/** Reads the connect challenge watchdog override from the process environment. */
export function getConnectChallengeTimeoutMsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env.OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS;
  if (raw) {
    const parsed = parseStrictPositiveInteger(raw);
    if (parsed !== undefined) {
      return resolveSafeTimeoutDelayMs(parsed);
    }
  }
  return undefined;
}

function normalizePositiveTimeoutMs(timeoutMs: unknown): number | undefined {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? resolveSafeTimeoutDelayMs(timeoutMs)
    : undefined;
}

/** Resolves the client watchdog timeout using explicit, env, then preauth defaults. */
export function resolveConnectChallengeTimeoutMs(
  timeoutMs?: number | null,
  params?: {
    env?: NodeJS.ProcessEnv;
    configuredTimeoutMs?: number | null;
  },
): number {
  const configuredPreauthTimeoutMs = resolvePreauthHandshakeTimeoutMs({
    env: params?.env,
    configuredTimeoutMs: params?.configuredTimeoutMs,
  });
  // The client watchdog must never fire before the server-side preauth timeout.
  // Tests may raise the env override above that server default, so widen the cap.
  const maxTimeoutMs = Math.max(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS, configuredPreauthTimeoutMs);
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
    return clampConnectChallengeTimeoutMs(timeoutMs, maxTimeoutMs);
  }
  const envOverride = getConnectChallengeTimeoutMsFromEnv(params?.env);
  if (envOverride !== undefined) {
    return clampConnectChallengeTimeoutMs(envOverride, Math.max(maxTimeoutMs, envOverride));
  }
  return clampConnectChallengeTimeoutMs(configuredPreauthTimeoutMs, maxTimeoutMs);
}

/** Resolves the server preauth timeout from env, explicit config, or default. */
export function resolvePreauthHandshakeTimeoutMs(params?: {
  env?: NodeJS.ProcessEnv;
  configuredTimeoutMs?: number | null;
}): number {
  const env = params?.env ?? process.env;
  const configuredTimeout =
    env.OPENCLAW_HANDSHAKE_TIMEOUT_MS ||
    (isTestRuntimeEnv(env) ? env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS : undefined);
  if (configuredTimeout) {
    const parsed = parseStrictPositiveInteger(configuredTimeout);
    if (parsed !== undefined) {
      return resolveSafeTimeoutDelayMs(parsed);
    }
  }
  const configured = normalizePositiveTimeoutMs(params?.configuredTimeoutMs);
  if (configured !== undefined) {
    return configured;
  }
  return DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS;
}
