// Google Chat reply delivery failure propagation covered against a real HTTP stub.
//
// These tests drive the production stack end to end: deliverGoogleChatReply ->
// sendGoogleChatMessage -> withGoogleChatResponse -> fetchWithSsrFGuard ->
// google-auth-library token exchange, with only global fetch stubbed to reroute
// oauth2.googleapis.com and chat.googleapis.com to a loopback impersonator.
// The service account key is a throwaway RSA key generated in-process; no real
// credentials or network access are involved.
import { generateKeyPairSync } from "node:crypto";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { deliverGoogleChatReply } from "./monitor-reply-delivery.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const account = {
  accountId: "default",
  enabled: true,
  credentialSource: "inline",
  credentials: {
    type: "service_account",
    client_email: "stub-bot@stub-project.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url:
      "https://www.googleapis.com/robot/v1/metadata/x509/stub-bot%40stub-project.iam.gserviceaccount.com",
  },
  config: {},
} as unknown as ResolvedGoogleChatAccount;

const config = {} as OpenClawConfig;

const CHUNKS = [
  "First chunk of the assistant reply.",
  "Second chunk of the assistant reply.",
  "Third chunk of the assistant reply.",
];

const core = {
  channel: {
    text: {
      resolveChunkMode: () => "markdown",
      // Deterministic 3-chunk split standing in for the core chunker; the
      // chunker is not the changed surface, the per-chunk send loop is.
      chunkMarkdownTextWithMode: () => CHUNKS,
    },
  },
} as unknown as GoogleChatCoreRuntime;

type CreateAttempt = { text?: string; status: number };

function createStubHandler(params: { failCreateIndexes: Set<number>; patchStatus?: number }) {
  const createAttempts: CreateAttempt[] = [];
  const patchAttempts: string[] = [];
  const handler = (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://stub.invalid");
      const json = (status: number, payload: unknown) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(payload));
      };
      if (req.method === "POST" && url.pathname === "/token") {
        json(200, { access_token: "ya29.stub-token", token_type: "Bearer", expires_in: 3600 });
        return;
      }
      const messagesMatch = url.pathname.match(/^\/v1\/(spaces\/[^/]+)\/messages$/);
      if (req.method === "POST" && messagesMatch) {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text?: string };
        const index = createAttempts.length + 1;
        const status = params.failCreateIndexes.has(index) ? 500 : 200;
        createAttempts.push({ text: body.text, status });
        if (status === 500) {
          json(500, {
            error: { code: 500, message: "stub: backend unavailable", status: "INTERNAL" },
          });
        } else {
          json(200, { name: `${messagesMatch[1]}/messages/stub-m${index}` });
        }
        return;
      }
      const messageMatch = url.pathname.match(/^\/v1\/(spaces\/[^/]+\/messages\/[^/]+)$/);
      if (req.method === "PATCH" && messageMatch?.[1]) {
        patchAttempts.push(messageMatch[1]);
        json(params.patchStatus ?? 200, {
          error: { code: 404, message: "stub: message not found", status: "NOT_FOUND" },
        });
        return;
      }
      json(400, { error: { code: 400, message: "stub: unhandled request" } });
    });
  };
  return { handler, createAttempts, patchAttempts };
}

function stubGoogleHostsFetch() {
  const realFetch = globalThis.fetch;
  let stubBaseUrl: string | undefined;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl);
    if (url.hostname === "chat.googleapis.com" || url.hostname === "oauth2.googleapis.com") {
      if (!stubBaseUrl) {
        throw new Error("stub server base URL not installed");
      }
      return await realFetch(`${stubBaseUrl}${url.pathname}${url.search}`, init);
    }
    return await realFetch(input, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    pointAtStub: (baseUrl: string) => {
      stubBaseUrl = baseUrl;
    },
  };
}

type DeliveryOutcome = {
  outcome: "delivered" | "failed-deliver";
  deliverError?: unknown;
  onErrorCalls: Array<{ err: unknown; kind: string }>;
  errorLines: string[];
};

async function runDelivery(params: { withTypingMessage?: boolean }): Promise<DeliveryOutcome> {
  const errorLines: string[] = [];
  const runtime: GoogleChatRuntimeEnv = {
    error: (line: string) => {
      errorLines.push(line);
    },
  };
  const onErrorCalls: Array<{ err: unknown; kind: string }> = [];
  // Mirror of monitor.ts: the channel deliver callback awaits
  // deliverGoogleChatReply, and the core reply dispatcher only treats a throw
  // as a failed delivery (src/auto-reply/reply/reply-dispatcher.ts).
  try {
    await deliverGoogleChatReply({
      payload: { text: CHUNKS.join("\n\n"), replyToId: "spaces/AAA/threads/root" },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
      ...(params.withTypingMessage
        ? {
            typingMessage: {
              name: "spaces/AAA/messages/typing",
              thread: "spaces/AAA/threads/root",
            },
          }
        : {}),
    });
    return { outcome: "delivered", onErrorCalls, errorLines };
  } catch (err) {
    onErrorCalls.push({ err, kind: "text" });
    return { outcome: "failed-deliver", deliverError: err, onErrorCalls, errorLines };
  }
}

describe("Google Chat reply delivery failure propagation (integration)", () => {
  let fetchControl: ReturnType<typeof stubGoogleHostsFetch>;

  beforeEach(() => {
    fetchControl = stubGoogleHostsFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces a failed non-first chunk send as a dispatcher-visible delivery failure", async () => {
    const stub = createStubHandler({ failCreateIndexes: new Set([2]) });
    await withServer(stub.handler, async (baseUrl) => {
      fetchControl.pointAtStub(baseUrl);
      const result = await runDelivery({});

      expect(result.outcome).toBe("failed-deliver");
      expect(result.deliverError).toBeInstanceOf(Error);
      expect((result.deliverError as Error).message).toContain("Google Chat API 500");
      expect((result.deliverError as Error).message).toContain("stub: backend unavailable");
      expect(result.onErrorCalls).toHaveLength(1);
      // The failing create rejects the whole delivery: the third chunk is never attempted.
      expect(stub.createAttempts.map((attempt) => attempt.status)).toEqual([200, 500]);
      expect(stub.createAttempts.map((attempt) => attempt.text)).toEqual([CHUNKS[0], CHUNKS[1]]);
      // Both Google hosts went through the production fetch path.
      const requestedUrls = fetchControl.fetchMock.mock.calls.map((call) => {
        const input = call[0] as RequestInfo | URL;
        return input instanceof Request ? input.url : String(input);
      });
      expect(requestedUrls.some((url) => url.startsWith("https://oauth2.googleapis.com/"))).toBe(
        true,
      );
      expect(
        requestedUrls.filter((url) => url.startsWith("https://chat.googleapis.com/")),
      ).toHaveLength(2);
    });
  });

  it("rejects when the resend after a typing-placeholder update failure also fails", async () => {
    const stub = createStubHandler({ failCreateIndexes: new Set([1]), patchStatus: 404 });
    await withServer(stub.handler, async (baseUrl) => {
      fetchControl.pointAtStub(baseUrl);
      const result = await runDelivery({ withTypingMessage: true });

      expect(result.outcome).toBe("failed-deliver");
      expect((result.deliverError as Error).message).toContain("Google Chat API 500");
      expect(result.onErrorCalls).toHaveLength(1);
      expect(stub.patchAttempts).toEqual(["spaces/AAA/messages/typing"]);
      expect(stub.createAttempts.map((attempt) => attempt.status)).toEqual([500]);
      // The recoverable placeholder failure stays logged, not fatal; only the
      // resend failure becomes the delivery error.
      expect(result.errorLines.some((line) => line.includes("Google Chat API 404"))).toBe(true);
    });
  });

  it("delivers every chunk when all message creates succeed", async () => {
    const stub = createStubHandler({ failCreateIndexes: new Set() });
    await withServer(stub.handler, async (baseUrl) => {
      fetchControl.pointAtStub(baseUrl);
      const result = await runDelivery({});

      expect(result.outcome).toBe("delivered");
      expect(result.onErrorCalls).toHaveLength(0);
      expect(stub.createAttempts.map((attempt) => attempt.status)).toEqual([200, 200, 200]);
      expect(stub.createAttempts.map((attempt) => attempt.text)).toEqual(CHUNKS);
    });
  });
});
