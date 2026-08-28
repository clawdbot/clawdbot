// Synology Chat helper module supports test http utils behavior.
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

function makeBaseReq(
  method: string,
  opts: { headers?: Record<string, string>; url?: string } = {},
): IncomingMessage & { destroyed: boolean } {
  const req = new EventEmitter() as IncomingMessage & { destroyed: boolean };
  req.method = method;
  req.headers = opts.headers ?? {};
  req.url = opts.url ?? "/webhook/synology";
  req.socket = { remoteAddress: "127.0.0.1" } as unknown as IncomingMessage["socket"];
  req.destroyed = false;
  req.destroy = ((_: Error | undefined) => {
    if (req.destroyed) {
      return req;
    }
    req.destroyed = true;
    return req;
  }) as IncomingMessage["destroy"];
  // Body readers pause rather than destroy when the caller still has to send a response,
  // so the double has to model that half of the Readable contract too.
  req.pause = () => req;
  return req;
}

export function makeReq(
  method: string,
  body: string,
  opts: { headers?: Record<string, string>; url?: string } = {},
): IncomingMessage {
  const req = makeBaseReq(method, opts);
  process.nextTick(() => {
    if (req.destroyed) {
      return;
    }
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

export function makeStalledReq(
  method: string,
  opts: { headers?: Record<string, string>; url?: string } = {},
): IncomingMessage {
  return makeBaseReq(method, opts);
}

export function makeRes(options: { finishOnEnd?: boolean } = {}): ServerResponse & {
  status: number;
  body: string | Buffer;
  headers: Record<string, string>;
  destroyed: boolean;
  emit: (eventName: string) => boolean;
} {
  let headersSent = false;
  const res = Object.assign(new EventEmitter(), {
    status: 0,
    body: "" as string | Buffer,
    headers: {} as Record<string, string>,
    destroyed: false,
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
    },
    writeHead(statusCode: number, _headers?: Record<string, string>) {
      res.status = statusCode;
    },
    end(body?: string | Buffer) {
      res.body = body ?? "";
      headersSent = true;
      if (options.finishOnEnd !== false) {
        queueMicrotask(() => res.emit("finish"));
      }
    },
    destroy() {
      res.destroyed = true;
      res.emit("close");
      return res;
    },
  }) as unknown as ServerResponse & {
    status: number;
    body: string | Buffer;
    headers: Record<string, string>;
    destroyed: boolean;
    emit: (eventName: string) => boolean;
  };
  Object.defineProperty(res, "statusCode", {
    configurable: true,
    enumerable: true,
    get() {
      return res.status;
    },
    set(value: number) {
      res.status = value;
    },
  });
  Object.defineProperty(res, "headersSent", {
    configurable: true,
    enumerable: true,
    get: () => headersSent,
  });
  return res;
}

export function makeFormBody(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}
