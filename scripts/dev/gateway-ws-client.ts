import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export type GatewayReqFrame = { type: "req"; id: string; method: string; params?: unknown };
export type GatewayResFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: unknown;
};
export type GatewayEventFrame = { type: "event"; event: string; seq?: number; payload?: unknown };
export type GatewayFrame =
  | GatewayReqFrame
  | GatewayResFrame
  | GatewayEventFrame
  | { type: string; [key: string]: unknown };

export function createArgReader(argv = process.argv.slice(2)) {
  const get = (flag: string) => {
    const idx = argv.indexOf(flag);
    if (idx !== -1 && idx + 1 < argv.length) {
      return argv[idx + 1];
    }
    return undefined;
  };
  const has = (flag: string) => argv.includes(flag);
  return { argv, get, has };
}

export function resolveGatewayUrl(urlRaw: string): URL {
  const url = new URL(urlRaw.includes("://") ? urlRaw : `wss://${urlRaw}`);
  if (!url.port) {
    url.port = url.protocol === "wss:" ? "443" : "80";
  }
  return url;
}

function toText(data: WebSocket.RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }
  return Buffer.from(data as Buffer).toString("utf8");
}

export function createGatewayWsClient(params: {
  url: string;
  handshakeTimeoutMs?: number;
  openTimeoutMs?: number;
  onEvent?: (evt: GatewayEventFrame) => void;
}) {
  const ws = new WebSocket(params.url, { handshakeTimeout: params.handshakeTimeoutMs ?? 8000 });
  const pending = new Map<
    string,
    {
      resolve: (res: GatewayResFrame) => void;
      reject: (err: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  const rejectPending = (error: Error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    pending.clear();
  };

  const request = (method: string, paramsObj?: unknown, timeoutMs = 12_000) =>
    new Promise<GatewayResFrame>((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`gateway websocket is not open for ${method}`));
        return;
      }
      const id = randomUUID();
      const frame: GatewayReqFrame = { type: "req", id, method, params: paramsObj };
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      try {
        ws.send(JSON.stringify(frame), (err) => {
          if (!err) {
            return;
          }
          const waiter = pending.get(id);
          if (!waiter) {
            return;
          }
          pending.delete(id);
          clearTimeout(waiter.timeout);
          waiter.reject(err instanceof Error ? err : new Error(String(err)));
        });
      } catch (err) {
        pending.delete(id);
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

  const waitOpen = () =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("ws open timeout")),
        params.openTimeoutMs ?? 8000,
      );
      ws.once("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(t);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });

  ws.on("message", (data) => {
    const text = toText(data);
    let frame: GatewayFrame | null = null;
    try {
      frame = JSON.parse(text) as GatewayFrame;
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object" || !("type" in frame)) {
      return;
    }
    if (frame.type === "res") {
      const res = frame as GatewayResFrame;
      const waiter = pending.get(res.id);
      if (waiter) {
        pending.delete(res.id);
        clearTimeout(waiter.timeout);
        waiter.resolve(res);
      }
      return;
    }
    if (frame.type === "event") {
      const evt = frame as GatewayEventFrame;
      params.onEvent?.(evt);
    }
  });
  ws.on("close", (code, reason) => {
    const suffix = reason.length > 0 ? `: ${reason.toString("utf8")}` : "";
    rejectPending(new Error(`gateway websocket closed (${code})${suffix}`));
  });
  ws.on("error", (err) => {
    rejectPending(err instanceof Error ? err : new Error(String(err)));
  });

  const close = () => {
    rejectPending(new Error("gateway websocket client closed"));
    ws.close();
  };

  return { ws, request, waitOpen, close };
}
