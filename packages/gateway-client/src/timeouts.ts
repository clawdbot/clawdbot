function parseStrictPositiveInteger(value: string): number | undefined {
  if (!/^[1-9]\d*$/u.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export const MAX_SAFE_TIMEOUT_DELAY_MS = 2_147_483_647;
export const DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 15_000;
export const MIN_CONNECT_CHALLENGE_TIMEOUT_MS = 250;
export const MAX_CONNECT_CHALLENGE_TIMEOUT_MS = DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS;

export function resolveSafeTimeoutDelayMs(delayMs: number, opts?: { minMs?: number }): number {
  const rawMinMs = opts?.minMs ?? 1;
  const minMs = Math.min(
    MAX_SAFE_TIMEOUT_DELAY_MS,
    Math.max(0, Number.isFinite(rawMinMs) ? Math.floor(rawMinMs) : 1),
  );
  const candidateMs = Number.isFinite(delayMs) ? Math.floor(delayMs) : minMs;
  return Math.min(MAX_SAFE_TIMEOUT_DELAY_MS, Math.max(minMs, candidateMs));
}

export function resolveFiniteTimeoutDelayMs(
  delayMs: number | null | undefined,
  fallbackMs: number,
  opts?: { minMs?: number },
): number {
  const candidateMs =
    typeof delayMs === "number" && Number.isFinite(delayMs) ? delayMs : fallbackMs;
  return resolveSafeTimeoutDelayMs(candidateMs, opts);
}

export function clampConnectChallengeTimeoutMs(
  timeoutMs: number,
  maxTimeoutMs = MAX_CONNECT_CHALLENGE_TIMEOUT_MS,
): number {
  return Math.max(
    MIN_CONNECT_CHALLENGE_TIMEOUT_MS,
    Math.min(Math.max(MIN_CONNECT_CHALLENGE_TIMEOUT_MS, maxTimeoutMs), timeoutMs),
  );
}

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

export function getPreauthHandshakeTimeoutMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const configuredTimeout =
    env.OPENCLAW_HANDSHAKE_TIMEOUT_MS || (env.VITEST && env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS);
  if (configuredTimeout) {
    const parsed = parseStrictPositiveInteger(configuredTimeout);
    if (parsed !== undefined) {
      return resolveSafeTimeoutDelayMs(parsed);
    }
  }
  return DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS;
}

export function resolvePreauthHandshakeTimeoutMs(params?: {
  env?: NodeJS.ProcessEnv;
  configuredTimeoutMs?: number | null;
}): number {
  const env = params?.env ?? process.env;
  const configuredTimeout =
    env.OPENCLAW_HANDSHAKE_TIMEOUT_MS || (env.VITEST && env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS);
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
