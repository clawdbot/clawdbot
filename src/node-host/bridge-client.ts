import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";

import type {
  BridgeErrorFrame,
  BridgeEventFrame,
  BridgeHelloFrame,
  BridgeHelloOkFrame,
  BridgeInvokeRequestFrame,
  BridgeInvokeResponseFrame,
  BridgePairOkFrame,
  BridgePairRequestFrame,
  BridgePingFrame,
  BridgePongFrame,
  BridgeRPCRequestFrame,
  BridgeRPCResponseFrame,
} from "../infra/bridge/server/types.js";

export type BridgeClientOptions = {
  host: string;
  port: number;
  tls?: boolean;
  tlsFingerprint?: string;
  nodeId: string;
  token?: string;
  displayName?: string;
  platform?: string;
  version?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  onInvoke?: (frame: BridgeInvokeRequestFrame) => void | Promise<void>;
  onEvent?: (frame: BridgeEventFrame) => void | Promise<void>;
  onPairToken?: (token: string) => void | Promise<void>;
  onAuthReset?: () => void | Promise<void>;
  onConnected?: (hello: BridgeHelloOkFrame) => void | Promise<void>;
  onDisconnected?: (err?: Error) => void | Promise<void>;
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void };
};

type PendingRpc = {
  resolve: (frame: BridgeRPCResponseFrame) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
};


function normalizeFingerprint(input: string): string {
  return input.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
}

function extractFingerprint(raw: tls.PeerCertificate | tls.DetailedPeerCertificate): string | null {
  const value = "fingerprint256" in raw ? raw.fingerprint256 : undefined;
  if (!value) return null;
  return normalizeFingerprint(value);
}

export class BridgeClient {
  private opts: BridgeClientOptions;
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = "";
  private pendingRpc = new Map<string, PendingRpc>();
  private connected = false;
  private helloReady: Promise<void> | null = null;
  private helloResolve: (() => void) | null = null;
  private helloReject: ((err: Error) => void) | null = null;

  constructor(opts: BridgeClientOptions) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.helloReady = new Promise<void>((resolve, reject) => {
      this.helloResolve = resolve;
      this.helloReject = reject;
    });
    const socket = this.opts.tls
      ? tls.connect({
          host: this.opts.host,
          port: this.opts.port,
          rejectUnauthorized: false,
        })
      : net.connect({ host: this.opts.host, port: this.opts.port });
    this.socket = socket;
    socket.setNoDelay(true);

    socket.on("connect", () => {
      this.sendHello();
    });
    socket.on("error", (err: Error) => {
      this.handleDisconnect(err);
    });
    socket.on("close", () => {
      this.handleDisconnect();
    });
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      this.flush();
    });

    if (this.opts.tls && socket instanceof tls.TLSSocket && this.opts.tlsFingerprint) {
      socket.once("secureConnect", () => {
        const cert = socket.getPeerCertificate(true);
        const fingerprint = cert ? extractFingerprint(cert) : null;
        if (!fingerprint || fingerprint !== normalizeFingerprint(this.opts.tlsFingerprint ?? "")) {
          const err = new Error("bridge tls fingerprint mismatch");
          this.handleDisconnect(err);
          socket.destroy(err);
        }
      });
    }

    await this.helloReady;
  }

  async close(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.pendingRpc.forEach((pending) => {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error("bridge client closed"));
    });
    this.pendingRpc.clear();
  }

  async request(method: string, params: Record<string, unknown> | null = null, timeoutMs = 5000) {
    const id = crypto.randomUUID();
    const frame: BridgeRPCRequestFrame = {
      type: "req",
      id,
      method,
      paramsJSON: params ? JSON.stringify(params) : null,
    };
    const res = await new Promise<BridgeRPCResponseFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`bridge request timeout (${method})`));
      }, timeoutMs);
      this.pendingRpc.set(id, { resolve, reject, timer });
      this.send(frame);
    });
    if (!res.ok) {
      throw new Error(res.error?.message ?? "bridge request failed");
    }
    return res.payloadJSON ? JSON.parse(res.payloadJSON) : null;
  }

  sendEvent(event: string, payload?: unknown) {
    const frame: BridgeEventFrame = {
      type: "event",
      event,
      payloadJSON: payload ? JSON.stringify(payload) : null,
    };
    this.send(frame);
  }

  sendInvokeResponse(frame: BridgeInvokeResponseFrame) {
    this.send(frame);
  }

  private sendHello() {
    const hello: BridgeHelloFrame = {
      type: "hello",
      nodeId: this.opts.nodeId,
      token: this.opts.token,
      displayName: this.opts.displayName,
      platform: this.opts.platform,
      version: this.opts.version,
      deviceFamily: this.opts.deviceFamily,
      modelIdentifier: this.opts.modelIdentifier,
      caps: this.opts.caps,
      commands: this.opts.commands,
      permissions: this.opts.permissions,
    };
    this.send(hello);
  }

  private sendPairRequest() {
    const req: BridgePairRequestFrame = {
      type: "pair-request",
      nodeId: this.opts.nodeId,
      displayName: this.opts.displayName,
      platform: this.opts.platform,
      version: this.opts.version,
      deviceFamily: this.opts.deviceFamily,
      modelIdentifier: this.opts.modelIdentifier,
      caps: this.opts.caps,
      commands: this.opts.commands,
      permissions: this.opts.permissions,
    };
    this.send(req);
  }

  private send(frame: object) {
    if (!this.socket) return;
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  private handleDisconnect(err?: Error) {
    if (!this.connected && this.helloReject) {
      this.helloReject(err ?? new Error("bridge connection failed"));
      this.helloResolve = null;
      this.helloReject = null;
    }
    if (!this.connected && !this.socket) return;
    this.connected = false;
    this.socket = null;
    this.pendingRpc.forEach((pending) => {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err ?? new Error("bridge connection closed"));
    });
    this.pendingRpc.clear();
    void this.opts.onDisconnected?.(err);
  }

  private flush() {
    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) break;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let frame: { type?: string; [key: string]: unknown };
      try {
        frame = JSON.parse(line) as { type?: string };
      } catch {
        continue;
      }
      this.handleFrame(frame as BridgeErrorFrame);
    }
  }

  private handleFrame(frame: {
    type?: string;
    [key: string]: unknown;
  }) {
    const type = String(frame.type ?? "");
    switch (type) {
      case "hello-ok": {
        this.connected = true;
        this.helloResolve?.();
        this.helloResolve = null;
        this.helloReject = null;
        void this.opts.onConnected?.(frame as BridgeHelloOkFrame);
        return;
      }
      case "pair-ok": {
        const token = String((frame as BridgePairOkFrame).token ?? "").trim();
        if (token) {
          this.opts.token = token;
          void this.opts.onPairToken?.(token);
        }
        return;
      }
      case "error": {
        const code = String((frame as BridgeErrorFrame).code ?? "");
        if (code === "NOT_PAIRED" || code === "UNAUTHORIZED") {
          this.opts.token = undefined;
          void this.opts.onAuthReset?.();
          this.sendPairRequest();
          return;
        }
        this.handleDisconnect(new Error((frame as BridgeErrorFrame).message ?? "bridge error"));
        return;
      }
      case "pong":
        return;
      case "ping": {
        const ping = frame as BridgePingFrame;
        const pong: BridgePongFrame = { type: "pong", id: String(ping.id ?? "") };
        this.send(pong);
        return;
      }
      case "event": {
        void this.opts.onEvent?.(frame as BridgeEventFrame);
        return;
      }
      case "res": {
        const res = frame as BridgeRPCResponseFrame;
        const pending = this.pendingRpc.get(res.id);
        if (pending) {
          if (pending.timer) clearTimeout(pending.timer);
          this.pendingRpc.delete(res.id);
          pending.resolve(res);
        }
        return;
      }
      case "invoke": {
        void this.opts.onInvoke?.(frame as BridgeInvokeRequestFrame);
        return;
      }
      case "invoke-res": {
        return;
      }
      default:
        return;
    }
  }
}
