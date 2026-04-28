import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";

export function createMockIncomingRequest(chunks: string[]): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & {
    destroyed?: boolean;
    destroy: (error?: Error) => IncomingMessage;
  };
  req.destroyed = false;
  req.headers = {};
  req.destroy = () => {
    req.destroyed = true;
    return req;
  };

  void Promise.resolve().then(() => {
    for (const chunk of chunks) {
      req.emit("data", Buffer.from(chunk, "utf-8"));
      if (req.destroyed) {
        return;
      }
    }
    req.emit("end");
  });

  return req;
}
