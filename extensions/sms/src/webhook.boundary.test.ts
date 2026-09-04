import { createHmac } from "node:crypto";
import {
  createServer,
  request,
  type ClientRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { createConnection } from "node:net";
import {
  createEmptyPluginRegistry,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startSmsGatewayAccount } from "./gateway.js";
import type { SmsChannelRuntime } from "./inbound.js";
import type { ResolvedSmsAccount } from "./types.js";

const enqueueSmsIngress = vi.hoisted(() =>
  vi.fn(async (_form: Record<string, string>) => ({ kind: "accepted" as const, duplicate: false })),
);
const startSmsIngress = vi.hoisted(() => vi.fn());
const pauseSmsIngress = vi.hoisted(() => vi.fn(async () => {}));
const stopSmsIngress = vi.hoisted(() => vi.fn(async () => {}));
const createSmsIngressSpool = vi.hoisted(() =>
  vi.fn(() => ({
    enqueue: enqueueSmsIngress,
    start: startSmsIngress,
    pause: pauseSmsIngress,
    stop: stopSmsIngress,
  })),
);

vi.mock("./ingress-spool.js", () => ({ createSmsIngressSpool }));

type HttpResult = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
};

type HeldRequest = {
  request: ClientRequest;
  finish: () => void;
  result: Promise<HttpResult>;
};

function createAccount(): ResolvedSmsAccount {
  return {
    accountId: "boundary",
    enabled: true,
    accountSid: "AC123",
    authToken: "secret",
    fromNumber: "+15557654321",
    messagingServiceSid: "",
    defaultTo: "",
    webhookPath: "/webhooks/sms",
    publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
    dangerouslyDisableSignatureValidation: false,
    dmPolicy: "pairing",
    allowFrom: [],
    textChunkLimit: 1500,
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected the SMS boundary server to have a TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

function readResponse(req: ClientRequest): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    req.once("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.once("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.once("error", reject);
  });
}

function holdIncompletePost(port: number, index: number): HeldRequest {
  const body = new URLSearchParams({ incomplete: String(index) }).toString();
  const req = request({
    host: "127.0.0.1",
    port,
    path: "/webhooks/sms",
    method: "POST",
    agent: false,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": Buffer.byteLength(body),
    },
  });
  const result = readResponse(req);
  void result.catch(() => {});
  req.write(body.slice(0, 1));
  return {
    request: req,
    finish: () => req.end(body.slice(1)),
    result,
  };
}

function postForm(params: { port: number; body: string; signature: string }): Promise<HttpResult> {
  const req = request({
    host: "127.0.0.1",
    port: params.port,
    path: "/webhooks/sms",
    method: "POST",
    agent: false,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": Buffer.byteLength(params.body),
      "x-twilio-signature": params.signature,
    },
  });
  const result = readResponse(req);
  req.end(params.body);
  return result;
}

function sendIncompleteRawPost(
  port: number,
): Promise<{ response: string; endedByServer: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
    const chunks: Buffer[] = [];
    let endedByServer = false;
    socket.once("connect", () => {
      socket.write(
        "POST /webhooks/sms HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${port}\r\n` +
          "Content-Type: application/x-www-form-urlencoded\r\n" +
          "Content-Length: 1024\r\n" +
          "Connection: keep-alive\r\n\r\n",
      );
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => {
      endedByServer = true;
      socket.end();
    });
    socket.once("close", () => {
      resolve({ response: Buffer.concat(chunks).toString("utf8"), endedByServer });
    });
    socket.once("error", reject);
  });
}

function computeTwilioSignature(params: {
  account: ResolvedSmsAccount;
  form: Record<string, string>;
}): string {
  const input =
    params.account.publicWebhookUrl +
    Object.keys(params.form)
      .toSorted()
      .map((key) => `${key}${params.form[key] ?? ""}`)
      .join("");
  return createHmac("sha1", params.account.authToken).update(input).digest("base64");
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("SMS webhook real route boundary", () => {
  afterEach(() => {
    enqueueSmsIngress.mockReset();
    enqueueSmsIngress.mockResolvedValue({ kind: "accepted", duplicate: false });
    startSmsIngress.mockClear();
    pauseSmsIngress.mockClear();
    stopSmsIngress.mockClear();
    createSmsIngressSpool.mockClear();
  });

  it("closes overflow uploads and recovers capacity for a signed callback", async () => {
    const account = createAccount();
    const registry = createEmptyPluginRegistry();
    const previousRegistry = getActivePluginRegistry();
    setActivePluginRegistry(registry);
    const abortController = new AbortController();
    const lifecycle = startSmsGatewayAccount({
      cfg: {},
      account,
      channelRuntime: {} as SmsChannelRuntime,
      abortSignal: abortController.signal,
    });
    await vi.waitFor(() => expect(registry.httpRoutes).toHaveLength(1));
    const route = registry.httpRoutes[0];
    if (!route) {
      throw new Error("expected the SMS gateway to register its account route");
    }

    let receivedRequests = 0;
    let heldBodyReaders = 0;
    let overflowRequestComplete: boolean | undefined;
    const server = createServer((req, res) => {
      receivedRequests += 1;
      const requestNumber = receivedRequests;
      if (requestNumber <= 64) {
        req.once("data", () => {
          heldBodyReaders += 1;
        });
      }
      void Promise.resolve(route.handler(req, res))
        .then(() => {
          if (requestNumber === 65) {
            overflowRequestComplete = req.complete;
          }
        })
        .catch((error: unknown) => {
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.end(error instanceof Error ? error.message : String(error));
          }
        });
    });
    const held: HeldRequest[] = [];

    try {
      const port = await listen(server);
      for (let index = 0; index < 64; index += 1) {
        held.push(holdIncompletePost(port, index));
      }
      await vi.waitFor(
        () => {
          expect(receivedRequests).toBe(64);
          expect(heldBodyReaders).toBe(64);
        },
        { timeout: 10_000 },
      );

      const overflow = await sendIncompleteRawPost(port);
      expect(overflow.response).toContain("HTTP/1.1 429 Too Many Requests\r\n");
      expect(overflow.response).toMatch(/\r\nConnection: close\r\n/iu);
      expect(overflow.response).toContain("\r\n\r\nRate limit exceeded");
      expect(overflow.endedByServer).toBe(true);
      await vi.waitFor(() => expect(overflowRequestComplete).toBe(false));
      expect(enqueueSmsIngress).not.toHaveBeenCalled();

      for (const pending of held) {
        pending.finish();
      }
      const released = await Promise.all(held.map((pending) => pending.result));
      expect(released.every((result) => result.statusCode === 403)).toBe(true);

      const form = {
        AccountSid: account.accountSid,
        From: "+15551234567",
        To: account.fromNumber,
        Body: "boundary proof",
        MessageSid: "SM00000000000000000000000000000985",
      };
      const body = new URLSearchParams(form).toString();
      const admitted = await postForm({
        port,
        body,
        signature: computeTwilioSignature({ account, form }),
      });

      expect(admitted.statusCode).toBe(200);
      expect(admitted.headers["x-openclaw-delivery-accepted"]).toBe("durable");
      expect(enqueueSmsIngress).toHaveBeenCalledOnce();
      expect(enqueueSmsIngress).toHaveBeenCalledWith(form);
    } finally {
      for (const pending of held) {
        pending.request.destroy();
      }
      await Promise.allSettled(held.map((pending) => pending.result));
      await closeServer(server);
      abortController.abort();
      await lifecycle;
      if (previousRegistry) {
        setActivePluginRegistry(previousRegistry);
      } else {
        resetPluginRuntimeStateForTest();
      }
    }
  });
});
