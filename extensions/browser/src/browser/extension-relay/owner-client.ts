import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import type { ConnectOverCDPTransport } from "playwright-core";
import type { WebSocket } from "ws";
import { z } from "zod";
import { parseStrictJsonObject } from "./auth-v2.js";
import { authenticateRelayOwner } from "./owner-auth-client.js";
import {
  RELAY_OWNER_LIMIT,
  relayOwnerFrame,
  relayOwnerReply,
  relayOwnerRetired,
  relayOwnerStatus,
  relayOwnerStreamClosed,
  type RelayOwnerStatus,
} from "./owner-protocol.js";

const nullableIdResult = z.string().nullable();
const streamIdResult = z.number().int().positive();

type OwnerStream = {
  send: (raw: string) => void;
  close: () => Promise<void>;
  onFrame?: (raw: string) => void;
  onClose?: () => void;
};

export type RelayOperationReference = {
  resolve: () => Promise<string | undefined>;
  release: () => Promise<void>;
  openTransport: () => Promise<ConnectOverCDPTransport>;
};

/** Client resources are leases on one socket and one proved listener lifetime. */
export class RelayOwnerClient {
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly streams = new Map<number, OwnerStream>();
  private profileAdmission: () => void = () => {};
  private sequence = 0;
  private closed = false;
  private retirementAcknowledged = false;
  private closing: Promise<void> | undefined;

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (raw) => {
      const parsed = parseStrictJsonObject(rawDataToString(raw));
      if (relayOwnerRetired.safeParse(parsed).success) {
        this.retirementAcknowledged = true;
        this.invalidate("Relay owner retired");
        return;
      }
      const reply = relayOwnerReply.safeParse(parsed);
      if (reply.success) {
        const pending = this.pending.get(reply.data.id);
        this.pending.delete(reply.data.id);
        if (reply.data.error) {
          pending?.reject(new Error(reply.data.error));
        } else {
          pending?.resolve(reply.data.result);
        }
        return;
      }
      const frame = relayOwnerFrame.safeParse(parsed);
      if (frame.success) {
        this.streams.get(frame.data.stream)?.onFrame?.(frame.data.frame);
        return;
      }
      const closed = relayOwnerStreamClosed.safeParse(parsed);
      if (closed.success) {
        this.streams.get(closed.data.stream)?.onClose?.();
        this.streams.delete(closed.data.stream);
        return;
      }
      ws.close(4003, "invalid relay owner response");
    });
    ws.once("close", () => this.invalidate("Relay owner connection lost"));
  }

  private invalidate(message: string): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new Error(message));
    }
    this.pending.clear();
    for (const stream of this.streams.values()) {
      stream.onClose?.();
    }
    this.streams.clear();
  }

  static async connect(params: {
    port: number;
    profile: string;
    token: string;
    signal: AbortSignal;
  }) {
    const { ws } = await authenticateRelayOwner(params);
    return new RelayOwnerClient(ws);
  }

  adoptProfileLease(assertCurrent: () => void): void {
    this.profileAdmission = assertCurrent;
  }

  get connected(): boolean {
    return !this.closed && !this.closing && this.ws.readyState === 1;
  }

  assertCurrent(): void {
    this.profileAdmission();
    if (this.closed || this.closing || this.ws.readyState !== 1) {
      throw new Error("Relay owner lease is no longer current");
    }
  }

  private async request(op: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed || this.ws.readyState !== 1 || this.pending.size >= RELAY_OWNER_LIMIT) {
      throw new Error("Relay owner connection unavailable");
    }
    const id = ++this.sequence;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<unknown>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error("Relay owner response timed out"));
          // A timed-out mutation cannot be reused as if it never happened.
          this.ws.terminate();
        }, 15_000);
        timer.unref?.();
        this.ws.send(JSON.stringify({ id, op, ...fields }));
      });
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async status(timeoutMs = 0): Promise<RelayOwnerStatus> {
    this.assertCurrent();
    const status = relayOwnerStatus.parse(await this.request("ready", { timeoutMs }));
    this.assertCurrent();
    return status;
  }

  async capture(
    targetId: string,
    assertOperationCurrent: () => void = () => {},
  ): Promise<RelayOperationReference> {
    this.assertCurrent();
    assertOperationCurrent();
    const ref = nullableIdResult.parse(await this.request("capture", { targetId }));
    try {
      this.assertCurrent();
      assertOperationCurrent();
    } catch (error) {
      if (ref) {
        await this.request("release", { ref });
      }
      throw error;
    }
    let released = false;
    const assertReference = () => {
      this.assertCurrent();
      assertOperationCurrent();
      if (released || !ref) {
        throw new Error("Relay operation target is unavailable");
      }
    };
    return {
      resolve: async () => {
        assertReference();
        const target = nullableIdResult.parse(await this.request("resolve", { ref }));
        assertReference();
        return target ?? undefined;
      },
      openTransport: async () => {
        assertReference();
        const transport = await this.openTransport(ref ?? undefined);
        try {
          assertReference();
          const send = transport.send.bind(transport);
          transport.send = (message) => {
            assertReference();
            send(message);
          };
          return transport;
        } catch (error) {
          transport.close();
          throw error;
        }
      },
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        if (ref) {
          await this.request("release", { ref });
        }
      },
    };
  }

  private async openStream(op: "cdp.open" | "ingress.open", ref?: string): Promise<OwnerStream> {
    this.assertCurrent();
    const id = streamIdResult.parse(await this.request(op, ref ? { ref } : {}));
    this.assertCurrent();
    let closed = false;
    let closing: Promise<void> | undefined;
    const stream: OwnerStream = {
      send: (frame) => {
        this.assertCurrent();
        if (closed) {
          throw new Error("Relay stream closed");
        }
        this.ws.send(JSON.stringify({ stream: id, frame }));
      },
      close: () => {
        closed = true;
        return (closing ??= this.request("stream.close", { stream: id }).then(() => {
          this.streams.delete(id);
          stream.onClose?.();
        }));
      },
    };
    this.streams.set(id, stream);
    return stream;
  }

  async openTransport(ref?: string): Promise<ConnectOverCDPTransport> {
    const stream = await this.openStream("cdp.open", ref);
    const transport: ConnectOverCDPTransport = {
      send: (message) => stream.send(JSON.stringify(message)),
      close: () => {
        void stream.close().catch(() => this.ws.terminate());
      },
    };
    stream.onFrame = (raw) => {
      const frame = parseStrictJsonObject(raw);
      if (!frame) {
        this.ws.terminate();
        return;
      }
      transport.onmessage?.(frame);
    };
    stream.onClose = () => transport.onclose?.("Relay CDP stream closed");
    return transport;
  }

  async prepareIngress(ws: WebSocket): Promise<() => void> {
    const stream = await this.openStream("ingress.open");
    const close = () => {
      void stream.close().catch(() => this.ws.terminate());
    };
    ws.once("close", close);
    if (ws.readyState !== 1) {
      close();
      throw new Error("Gateway extension connection lost");
    }
    return () => {
      this.assertCurrent();
      stream.onFrame = (raw) => {
        if (ws.readyState === 1) {
          ws.send(raw);
        }
      };
      stream.onClose = () => ws.close(1011, "Relay ingress lease closed");
      ws.on("message", (raw) => {
        try {
          stream.send(rawDataToString(raw));
        } catch {
          ws.close(1011, "Relay ingress lease closed");
        }
      });
    };
  }

  close(): Promise<void> {
    if (this.retirementAcknowledged) {
      return Promise.resolve();
    }
    return (this.closing ??= this.request("close").then(() => {
      this.closed = true;
      this.ws.close();
    }));
  }
}
