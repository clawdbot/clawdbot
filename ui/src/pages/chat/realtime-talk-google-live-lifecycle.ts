import type {
  RealtimeTalkJsonPcmWebSocketSessionResult,
  RealtimeTalkTransportStartResult,
} from "./realtime-talk-shared.ts";

const GOOGLE_LIVE_WEBSOCKET_HOST = "generativelanguage.googleapis.com";
const GOOGLE_LIVE_WEBSOCKET_PATH =
  /^\/ws\/google\.ai\.generativelanguage\.v[0-9a-z]+\.GenerativeService\.BidiGenerateContent(?:Constrained)?$/;
export const GOOGLE_LIVE_SETUP_TIMEOUT_MS = 30_000;

export function buildGoogleLiveUrl(session: RealtimeTalkJsonPcmWebSocketSessionResult): string {
  let url: URL;
  try {
    url = new URL(session.websocketUrl);
  } catch {
    throw new Error("Invalid Google Live WebSocket URL");
  }
  if (url.protocol !== "wss:") {
    throw new Error("Google Live WebSocket URL must use wss://");
  }
  if (url.hostname.toLowerCase() !== GOOGLE_LIVE_WEBSOCKET_HOST) {
    throw new Error("Untrusted Google Live WebSocket host");
  }
  if (url.username || url.password) {
    throw new Error("Google Live WebSocket URL must not include credentials");
  }
  if (!GOOGLE_LIVE_WEBSOCKET_PATH.test(url.pathname)) {
    throw new Error("Untrusted Google Live WebSocket path");
  }
  url.search = "";
  url.searchParams.set("access_token", session.clientSecret);
  return url.toString();
}

type GoogleLiveConnectionState =
  | "idle"
  | "connecting"
  | "ready"
  | "active"
  | "cancelled"
  | "failed";

type StartupWaiter = {
  resolve: (result: RealtimeTalkTransportStartResult) => void;
  reject: (error: Error) => void;
};

export class GoogleLiveConnectionLifecycle {
  private state: GoogleLiveConnectionState = "idle";
  private socket: WebSocket | null = null;
  private waiter: StartupWaiter | null = null;
  private error: Error | null = null;

  get currentState(): GoogleLiveConnectionState {
    return this.state;
  }

  get isActive(): boolean {
    return this.state === "active";
  }

  get setupComplete(): boolean {
    return this.state === "ready" || this.state === "active";
  }

  begin(socket: WebSocket): Promise<RealtimeTalkTransportStartResult> {
    this.state = "connecting";
    this.socket = socket;
    this.error = null;
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  markReady(socket: WebSocket): boolean {
    if (this.state !== "connecting" || this.socket !== socket) {
      return false;
    }
    this.state = "ready";
    this.takeWaiter()?.resolve("ready");
    return true;
  }

  finishStart(result: RealtimeTalkTransportStartResult): RealtimeTalkTransportStartResult {
    if (this.error) {
      throw this.error;
    }
    return this.state === "cancelled" ? "cancelled" : result;
  }

  activate(): boolean {
    if (this.state === "active") {
      return false;
    }
    if (this.error) {
      throw this.error;
    }
    if (this.state === "cancelled" || this.state === "idle") {
      return false;
    }
    if (this.state !== "ready") {
      throw new Error("Google Live transport activated before setup completed");
    }
    this.state = "active";
    return true;
  }

  failStartup(socket: WebSocket, error: Error): boolean {
    if (this.socket !== socket || (this.state !== "connecting" && this.state !== "ready")) {
      return false;
    }
    this.state = "failed";
    this.error = error;
    this.takeWaiter()?.reject(error);
    return true;
  }

  cancel(): void {
    if (this.state === "cancelled" || this.state === "failed") {
      return;
    }
    this.state = "cancelled";
    this.takeWaiter()?.resolve("cancelled");
  }

  private takeWaiter(): StartupWaiter | null {
    const waiter = this.waiter;
    this.waiter = null;
    return waiter;
  }
}

export function runRealtimeTalkCleanup(steps: Array<() => void>): void {
  let firstError: Error | undefined;
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      firstError ??=
        error instanceof Error
          ? error
          : new Error("Realtime Talk cleanup failed", { cause: error });
    }
  }
  if (firstError) {
    throw firstError;
  }
}
