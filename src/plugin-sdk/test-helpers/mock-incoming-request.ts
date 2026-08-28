/**
 * Mock IncomingMessage builder for webhook and HTTP request tests.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";

export function createMockIncomingRequest(chunks: string[]): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & {
    destroyed?: boolean;
    destroy: (error?: Error) => IncomingMessage;
  };
  let paused = false;
  req.destroyed = false;
  req.headers = {};
  req.destroy = () => {
    req.destroyed = true;
    return req;
  };
  // Readable contract: pausing stops delivery without tearing the request down. Body
  // readers use it to stop an over-limit stream while leaving the response writable,
  // so a mock without it can only ever exercise the destroying path.
  req.pause = () => {
    paused = true;
    return req;
  };

  void Promise.resolve().then(() => {
    for (const chunk of chunks) {
      req.emit("data", Buffer.from(chunk, "utf-8"));
      if (req.destroyed || paused) {
        return;
      }
    }
    req.emit("end");
  });

  return req;
}
