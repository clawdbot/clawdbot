// Shared fixtures for Reef transport tests.
import { ReefTransportClient } from "./transport.js";
import type { InboxEntry, ReefKeys } from "./types.js";

export const ts = 1_752_300_000;
export const signing = {
  secretKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  publicKey: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
};
const keys: ReefKeys = {
  signing,
  encryption: {
    secretKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
  auditKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  replayKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  keyEpoch: 1,
};

export function createClient(
  fetcher: typeof fetch,
  clock: () => number = () => ts,
  baseUrl = "https://relay.example",
): ReefTransportClient {
  return new ReefTransportClient(baseUrl, "alice", keys, fetcher, clock);
}

export class ControlledSocket {
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  readonly sent: string[] = [];
  closed = false;

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emit("close");
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

export function receiptEntry(seq: number): InboxEntry {
  return {
    seq,
    peer: "bob",
    id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(seq).padStart(2, "0")}`,
    kind: "receipt",
    receipt: { id: `receipt-${seq}` } as never,
    ts,
  };
}

export function parseRequestUrl(input: URL | RequestInfo): URL {
  if (input instanceof URL) {
    return input;
  }
  return new URL(typeof input === "string" ? input : input.url);
}
