import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";

const DECRYPT_FAILURE_WINDOW_MS = 30_000;
const DECRYPT_FAILURE_RECONNECT_THRESHOLD = 3;
const DECRYPT_FAILURE_PATTERN = /DecryptionFailed\(/;
const DAVE_PASSTHROUGH_DISABLED_PATTERN = /UnencryptedWhenPassthroughDisabled/;

export const DAVE_RECEIVE_PASSTHROUGH_INITIAL_EXPIRY_SECONDS = 30;
export const DAVE_RECEIVE_PASSTHROUGH_REARM_EXPIRY_SECONDS = 15;

export type VoiceReceiveRecoveryState = {
  decryptFailureCount: number;
  lastDecryptFailureAt: number;
  decryptRecoveryInFlight: boolean;
};

export type VoiceReceiveErrorAnalysis = {
  message: string;
  isAbortLike: boolean;
  shouldAttemptPassthrough: boolean;
  countsAsDecryptFailure: boolean;
};

type DavePassthroughTarget = {
  guildId: string;
  channelId: string;
  connection: {
    state: {
      status: unknown;
      networking?: {
        state?: {
          code?: unknown;
          dave?: {
            session?: {
              setPassthroughMode: (passthrough: boolean, expirySeconds: number) => void;
            };
          };
        };
      };
    };
  };
};

type DavePassthroughSdk = {
  VoiceConnectionStatus: {
    Ready: unknown;
  };
  NetworkingStatusCode: {
    Ready: unknown;
    Resuming: unknown;
  };
};

export function createVoiceReceiveRecoveryState(): VoiceReceiveRecoveryState {
  return {
    decryptFailureCount: 0,
    lastDecryptFailureAt: 0,
    decryptRecoveryInFlight: false,
  };
}

export function isAbortLikeReceiveError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const name =
    "name" in err && typeof (err as { name?: unknown }).name === "string"
      ? (err as { name: string }).name
      : "";
  const message =
    "message" in err && typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message
      : "";
  return (
    name === "AbortError" ||
    message.includes("The operation was aborted") ||
    message.includes("aborted")
  );
}

export function analyzeVoiceReceiveError(err: unknown): VoiceReceiveErrorAnalysis {
  const message = formatErrorMessage(err);
  const shouldAttemptPassthrough = DAVE_PASSTHROUGH_DISABLED_PATTERN.test(message);
  return {
    message,
    isAbortLike: isAbortLikeReceiveError(err),
    shouldAttemptPassthrough,
    countsAsDecryptFailure: DECRYPT_FAILURE_PATTERN.test(message) || shouldAttemptPassthrough,
  };
}

export function noteVoiceDecryptFailure(
  state: VoiceReceiveRecoveryState,
  now: number = Date.now(),
): {
  firstFailure: boolean;
  shouldRecover: boolean;
} {
  if (now - state.lastDecryptFailureAt > DECRYPT_FAILURE_WINDOW_MS) {
    state.decryptFailureCount = 0;
  }
  state.lastDecryptFailureAt = now;
  state.decryptFailureCount += 1;
  const firstFailure = state.decryptFailureCount === 1;
  if (
    state.decryptFailureCount < DECRYPT_FAILURE_RECONNECT_THRESHOLD ||
    state.decryptRecoveryInFlight
  ) {
    return { firstFailure, shouldRecover: false };
  }
  state.decryptRecoveryInFlight = true;
  resetVoiceReceiveRecoveryState(state);
  return { firstFailure, shouldRecover: true };
}

export function resetVoiceReceiveRecoveryState(state: VoiceReceiveRecoveryState): void {
  state.decryptFailureCount = 0;
  state.lastDecryptFailureAt = 0;
}

export function finishVoiceDecryptRecovery(state: VoiceReceiveRecoveryState): void {
  state.decryptRecoveryInFlight = false;
}

export function enableDaveReceivePassthrough(params: {
  target: DavePassthroughTarget;
  sdk: DavePassthroughSdk;
  reason: string;
  expirySeconds: number;
  onVerbose: (message: string) => void;
  onWarn: (message: string) => void;
}): boolean {
  const { target, sdk, reason, expirySeconds, onVerbose, onWarn } = params;
  const networkingState = target.connection.state.networking?.state;
  if (
    target.connection.state.status !== sdk.VoiceConnectionStatus.Ready ||
    !networkingState ||
    (networkingState.code !== sdk.NetworkingStatusCode.Ready &&
      networkingState.code !== sdk.NetworkingStatusCode.Resuming)
  ) {
    return false;
  }
  const daveSession = networkingState.dave?.session;
  if (!daveSession) {
    return false;
  }
  try {
    daveSession.setPassthroughMode(true, expirySeconds);
    onVerbose(
      `enabled DAVE receive passthrough: guild ${target.guildId} channel ${target.channelId} expiry=${expirySeconds}s reason=${reason}`,
    );
    return true;
  } catch (err) {
    onWarn(
      `discord voice: failed to enable DAVE passthrough guild=${target.guildId} channel=${target.channelId} reason=${reason}: ${formatErrorMessage(err)}`,
    );
    return false;
  }
}
