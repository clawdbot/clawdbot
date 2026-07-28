// Regression test: qa-bus client coerces non-Error readByteStreamWithLimit
// rejections through the shared toErrorObject (the "Non-Error rejection"
// fallback at the postJson rejection handler). Real HTTP errors are Error
// instances (Node/undici wrap them), so the non-Error coercion branch is
// exercised by injecting a non-Error rejection from readByteStreamWithLimit.
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/response-limit-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/response-limit-runtime")>();
  return {
    ...actual,
    // Reject with a non-Error value so the toErrorObject coercion branch fires.
    readByteStreamWithLimit: vi.fn().mockRejectedValue({ code: 500, status: "server_error" }),
  };
});

import { sendQaBusMessage } from "./bus-client.js";

describe("qa-bus client non-Error rejection coercion", () => {
  it("coerces non-Error readByteStreamWithLimit rejections via the shared toErrorObject", async () => {
    const server = await new Promise<ReturnType<typeof createServer>>((resolve) => {
      const s = createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;
    try {
      const thrown = await sendQaBusMessage({
        baseUrl: `http://127.0.0.1:${port}`,
        accountId: "acct-a",
        to: "dest",
        text: "hi",
      }).catch((err: unknown) => err);
      // The shared toErrorObject wraps the non-Error value with its fallback
      // message and copies enumerable fields (code, status) onto the Error.
      expect(thrown).toBeInstanceOf(Error);
      const thrownErr = thrown as Error & { code?: unknown; status?: unknown };
      expect(thrownErr.message).toBe("Non-Error rejection");
      expect(thrownErr.code).toBe(500);
      expect(thrownErr.status).toBe("server_error");
    } finally {
      server.close();
    }
  });
});
