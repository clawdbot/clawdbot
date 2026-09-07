import type { DesktopObserveResult, WorkerDesktopAppId } from "@openclaw/gateway-protocol";
import type { DesktopConnectionHandle } from "./desktop-client.ts";

export type DesktopAppId = WorkerDesktopAppId;
export type DesktopCredentials = { username?: string; password?: string };

export type PendingDesktopConnection = {
  environmentId: string;
  control: boolean;
  observed?: DesktopObserveResult;
  operationId: number;
};

export type ObservedDesktopConnection = PendingDesktopConnection & {
  observed: DesktopObserveResult;
};

/** Keeps a same-source viewer alive until its replacement finishes RFB authentication. */
export class DesktopConnectionHandoff {
  private current: DesktopConnectionHandle | null = null;
  private retained: DesktopConnectionHandle | null = null;
  private connected = false;

  get handle(): DesktopConnectionHandle | null {
    return this.connected ? this.current : null;
  }

  begin(retainViewer: boolean): void {
    const retained = retainViewer ? (this.connected ? this.current : this.retained) : null;
    const current = this.current;
    const previous = this.retained;
    this.current = null;
    this.retained = retained;
    this.connected = false;
    if (current !== retained) {
      current?.disconnect();
    }
    if (previous !== retained) {
      previous?.disconnect();
    }
    retained?.disableInput();
  }

  attach(handle: DesktopConnectionHandle): void {
    this.current = handle;
  }

  markConnected(): void {
    // A returned handle or observe result is not the RFB authentication boundary.
    this.connected = true;
    const retained = this.retained;
    this.retained = null;
    retained?.disconnect();
  }

  disconnect(): void {
    this.begin(false);
  }
}
