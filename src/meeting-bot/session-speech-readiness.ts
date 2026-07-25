import type { MeetingBrowserHealth } from "./session-types.js";

type SpeechMessages<TReason extends string> = {
  audioBridgeUnavailable: string;
  audioBridgeUnavailableReason: TReason;
  browserUnverified: string;
  browserUnverifiedReason: TReason;
  manualActionFallback: string;
  microphoneMuted: string;
  microphoneMutedReason: TReason;
  notInCall: string;
  notInCallReason: TReason;
};

export function evaluateMeetingSpeechReadiness<TReason extends string>(params: {
  browser:
    | {
        hasAudioBridge: boolean;
        health?: MeetingBrowserHealth<string, TReason>;
      }
    | undefined;
  managedBrowser: boolean;
  speech: SpeechMessages<TReason>;
  talkBack: boolean;
}): { ready: boolean; reason?: TReason; message?: string } {
  const { browser, speech } = params;
  if (!params.talkBack || !browser) {
    return { ready: true };
  }
  if (!params.managedBrowser) {
    return browser.hasAudioBridge
      ? { ready: true }
      : {
          ready: false,
          reason: speech.audioBridgeUnavailableReason,
          message: speech.audioBridgeUnavailable,
        };
  }
  const health = browser.health;
  if (health?.manualActionRequired) {
    return {
      ready: false,
      reason: (health.manualActionReason ?? speech.browserUnverifiedReason) as TReason,
      message: health.manualActionMessage ?? speech.manualActionFallback,
    };
  }
  if (health?.inCall === true) {
    if (health.micMuted !== false) {
      const muted = health.micMuted === true;
      // Unknown is transiently blocked: omitted mic controls cannot prove talk-back readiness.
      return {
        ready: false,
        reason: muted ? speech.microphoneMutedReason : speech.browserUnverifiedReason,
        message: muted ? speech.microphoneMuted : speech.browserUnverified,
      };
    }
    return browser.hasAudioBridge
      ? { ready: true }
      : {
          ready: false,
          reason: speech.audioBridgeUnavailableReason,
          message: speech.audioBridgeUnavailable,
        };
  }
  if (health?.inCall === false) {
    return { ready: false, reason: speech.notInCallReason, message: speech.notInCall };
  }
  return {
    ready: false,
    reason: speech.browserUnverifiedReason,
    message: speech.browserUnverified,
  };
}
