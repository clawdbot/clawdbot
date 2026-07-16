import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

export function makeBaseReq(
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

export function makeRes(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: "",
    writeHead(statusCode: number, _headers: Record<string, string>) {
      res._status = statusCode;
    },
    end(body?: string) {
      res._body = body ?? "";
    },
  } as unknown as ServerResponse & { _status: number; _body: string };
  Object.defineProperty(res, "statusCode", {
    configurable: true,
    enumerable: true,
    get() {
      return res._status;
    },
    set(value: number) {
      res._status = value;
    },
  });
  return res;
}

export function makeFormBody(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}
