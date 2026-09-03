/**
 * Mock IncomingMessage builder for webhook and HTTP request tests.
 */
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

export function createMockIncomingRequest(chunks: string[]): IncomingMessage {
  const req = new IncomingMessage(new Socket());

  void Promise.resolve().then(() => {
    for (const chunk of chunks) {
      if (req.destroyed) {
        return;
      }
      req.push(Buffer.from(chunk, "utf-8"));
    }
    // Like Node's parser, mark complete before EOF so normal cleanup keeps the socket open.
    req.complete = true;
    req.push(null);
  });

  return req;
}
