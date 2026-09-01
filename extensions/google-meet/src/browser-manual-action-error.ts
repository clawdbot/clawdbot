import type { GoogleMeetChromeHealth } from "./transports/types.js";

type GoogleMeetBrowserManualActionState = NonNullable<GoogleMeetChromeHealth["manualAction"]>;

type GoogleMeetBrowserManualAction = {
  source: "browser";
  error: string;
  manualAction: GoogleMeetBrowserManualActionState;
  browser: {
    nodeId: string;
    targetId?: string;
    browserUrl?: string;
    browserTitle?: string;
    notes?: string[];
  };
};

export class GoogleMeetBrowserManualActionError extends Error {
  readonly payload: GoogleMeetBrowserManualAction;

  constructor(payload: Omit<GoogleMeetBrowserManualAction, "source" | "error">) {
    super(`${payload.manualAction.reason}: ${payload.manualAction.message}`);
    this.name = "GoogleMeetBrowserManualActionError";
    this.payload = {
      source: "browser",
      error: this.message,
      ...payload,
    };
  }
}

export function isGoogleMeetBrowserManualActionError(
  error: unknown,
): error is GoogleMeetBrowserManualActionError {
  return error instanceof GoogleMeetBrowserManualActionError;
}
