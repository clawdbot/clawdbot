// Re-export gateway-client handshake timeout helpers so server code and client
// packages share the same preauth/connect timeout bounds.
export {
  clampConnectChallengeTimeoutMs,
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  getConnectChallengeTimeoutMsFromEnv,
  getPreauthHandshakeTimeoutMsFromEnv,
  MAX_CONNECT_CHALLENGE_TIMEOUT_MS,
  MIN_CONNECT_CHALLENGE_TIMEOUT_MS,
  resolveConnectChallengeTimeoutMs,
  resolvePreauthHandshakeTimeoutMs,
} from "../../packages/gateway-client/src/timeouts.js";
