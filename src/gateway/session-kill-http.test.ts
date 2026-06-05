// Session kill HTTP tests cover subagent kill authorization, requester/admin
// scope handling, local request checks, and error responses.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayAuthResult } from "./auth.js";

const TEST_GATEWAY_TOKEN = "test-gateway-token-1234567890";
const WORKER_SESSION_KEY = "agent:main:subagent:worker";
const WORKER_KILL_PATH = "/sessions/agent%3Amain%3Asubagent%3Aworker/kill";
const ADMIN_SCOPE_HEADERS = {
  "x-openclaw-scopes": "operator.admin",
};
const REQUESTER_WRITE_HEADERS = {
  "x-openclaw-scopes": "operator.write",
  "x-openclaw-requester-session-key": "agent:main:main",
};

let cfg: Record<string, unknown> = {};
const authMock = vi.fn(async (): Promise<GatewayAuthResult> => ({ ok: true }));
const isLocalDirectRequestMock = vi.fn(() => true);
const loadSessionEntryMock = vi.fn();
const getLatestSubagentRunByChildSessionKeyMock = vi.fn();
const resolveSubagentControllerMock = vi.fn();
const killControlledSubagentRunMock = vi.fn();
const killSubagentRunAdminMock = vi.fn();

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => cfg,
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => cfg,
}));

vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: authMock,
  isLocalDirectRequest: isLocalDirectRequestMock,
}));

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: loadSessionEntryMock,
}));

vi.mock("../agents/subagent-registry.js", () => ({
  getLatestSubagentRunByChildSessionKey: getLatestSubagentRunByChildSessionKeyMock,
}));

vi.mock("../agents/subagent-control.js", () => ({
  killControlledSubagentRun: killControlledSubagentRunMock,
  killSubagentRunAdmin: killSubagentRunAdminMock,
  resolveSubagentController: resolveSubagentControllerMock,
}));

const { handleSessionKillHttpRequest } = await import("./session-kill-http.js");

let port = 0;
let server: ReturnType<typeof createServer> | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    void handleSessionKillHttpRequest(req, res, {
      auth: { mode: "token", token: TEST_GATEWAY_TOKEN, allowTailscale: false },
    }).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("not found");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", () => {
      const address = server?.address() as AddressInfo | null;
      if (!address) {
        reject(new Error("server missing address"));
        return;
      }
      port = address.port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server?.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(() => {
  cfg = {};
  authMock.mockReset();
  authMock.mockResolvedValue({ ok: true, method: "token" });
  isLocalDirectRequestMock.mockReset();
  isLocalDirectRequestMock.mockReturnValue(true);
  loadSessionEntryMock.mockReset();
  getLatestSubagentRunByChildSessionKeyMock.mockReset();
  resolveSubagentControllerMock.mockReset();
  resolveSubagentControllerMock.mockReturnValue({ controllerSessionKey: "agent:main:main" });
  killControlledSubagentRunMock.mockReset();
  killSubagentRunAdminMock.mockReset();
});

async function post(
  pathname: string,
  token = TEST_GATEWAY_TOKEN,
  extraHeaders?: Record<string, string>,
) {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  Object.assign(headers, extraHeaders ?? {});
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers,
  });
}

function postWorkerKill(token = TEST_GATEWAY_TOKEN, extraHeaders?: Record<string, string>) {
  return post(WORKER_KILL_PATH, token, extraHeaders);
}

function allowTrustedProxyAuth() {
  authMock.mockResolvedValueOnce({ ok: true, method: "trusted-proxy" });
}

function mockWorkerSession() {
  loadSessionEntryMock.mockReturnValue({
    entry: { sessionId: "sess-worker", updatedAt: Date.now() },
    canonicalKey: WORKER_SESSION_KEY,
  });
}

function allowRemoteRequesterKill() {
  isLocalDirectRequestMock.mockReturnValue(false);
  allowTrustedProxyAuth();
  mockWorkerSession();
}

async function expectForbiddenMissingScope(response: Response, message: string) {
  expect(response.status).toBe(403);
  expectErrorResponse(await response.json(), {
    type: "forbidden",
    message,
  });
}

async function expectRequesterKillResponse(response: Response, killed: boolean) {
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true, killed });
}

function expectErrorResponse(body: unknown, expected: { type: string; message?: string }) {
  const response = body as {
    ok?: unknown;
    error?: { type?: unknown; message?: unknown };
  };
  if (Object.hasOwn(response, "ok")) {
    expect(response.ok).toBe(false);
  }
  expect(response.error?.type).toBe(expected.type);
  if (expected.message !== undefined) {
    expect(response.error?.message).toBe(expected.message);
  }
}

describe("POST /sessions/:sessionKey/kill", () => {
  it("returns 401 when auth fails", async () => {
    authMock.mockResolvedValueOnce({ ok: false, rateLimited: false });

    const response = await postWorkerKill();
    expect(response.status).toBe(401);
  });

  it("returns 404 when the session key is not in the session store", async () => {
    allowTrustedProxyAuth();
    loadSessionEntryMock.mockReturnValue({ entry: undefined });

    const response = await postWorkerKill(TEST_GATEWAY_TOKEN, ADMIN_SCOPE_HEADERS);
    expect(response.status).toBe(404);
    expectErrorResponse(await response.json(), { type: "not_found" });
    expect(killSubagentRunAdminMock).not.toHaveBeenCalled();
  });

  it("matches kill paths without trusting malformed Host headers", async () => {
    allowTrustedProxyAuth();
    loadSessionEntryMock.mockReturnValue({ entry: undefined });

    const response = await postWorkerKill(TEST_GATEWAY_TOKEN, {
      Host: "[",
      ...ADMIN_SCOPE_HEADERS,
    });
    expect(response.status).toBe(404);
    expectErrorResponse(await response.json(), { type: "not_found" });
    expect(loadSessionEntryMock).toHaveBeenCalled();
  });

  it.each(["/sessions/%zz/kill", "/sessions/%20/kill"])(
    "rejects invalid encoded session key %s without falling through",
    async (pathname) => {
      const response = await post(pathname);
      expect(response.status).toBe(400);
      expectErrorResponse(await response.json(), {
        message: "invalid session key",
        type: "invalid_request_error",
      });
      expect(authMock).not.toHaveBeenCalled();
      expect(loadSessionEntryMock).not.toHaveBeenCalled();
      expect(killSubagentRunAdminMock).not.toHaveBeenCalled();
      expect(killControlledSubagentRunMock).not.toHaveBeenCalled();
    },
  );

  it("kills a matching session via the admin kill helper using the canonical key", async () => {
    allowTrustedProxyAuth();
    loadSessionEntryMock.mockReturnValue({
      entry: { sessionId: "sess-worker", updatedAt: Date.now() },
      canonicalKey: WORKER_SESSION_KEY,
    });
    killSubagentRunAdminMock.mockResolvedValue({ found: true, killed: true });

    const response = await post(
      "/sessions/agent%3AMain%3ASubagent%3AWorker/kill",
      TEST_GATEWAY_TOKEN,
      {
        "x-openclaw-scopes": "operator.admin",
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, killed: true });
    expect(killSubagentRunAdminMock).toHaveBeenCalledWith({
      cfg,
      sessionKey: WORKER_SESSION_KEY,
    });
  });

  it("returns killed=false when the target exists but nothing was stopped", async () => {
    allowTrustedProxyAuth();
    mockWorkerSession();
    killSubagentRunAdminMock.mockResolvedValue({ found: true, killed: false });

    const response = await postWorkerKill(TEST_GATEWAY_TOKEN, ADMIN_SCOPE_HEADERS);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, killed: false });
  });

  it("rejects local bearer-auth kills without a trusted admin scope surface", async () => {
    const response = await postWorkerKill();
    await expectForbiddenMissingScope(response, "missing scope: operator.admin");
    expect(loadSessionEntryMock).not.toHaveBeenCalled();
    expect(killSubagentRunAdminMock).not.toHaveBeenCalled();
  });

  it("does not trust x-openclaw-scopes on shared-secret bearer auth", async () => {
    const response = await postWorkerKill(TEST_GATEWAY_TOKEN, ADMIN_SCOPE_HEADERS);
    await expectForbiddenMissingScope(response, "missing scope: operator.admin");
    expect(loadSessionEntryMock).not.toHaveBeenCalled();
    expect(killSubagentRunAdminMock).not.toHaveBeenCalled();
  });

  it("rejects remote bearer-auth kills without requester ownership", async () => {
    isLocalDirectRequestMock.mockReturnValue(false);
    mockWorkerSession();

    const response = await postWorkerKill();
    expect(response.status).toBe(403);
    expectErrorResponse(await response.json(), { type: "forbidden" });
    expect(killSubagentRunAdminMock).not.toHaveBeenCalled();
  });

  it("rejects remote kills without requester ownership or an authorized token", async () => {
    isLocalDirectRequestMock.mockReturnValue(false);
    authMock.mockResolvedValueOnce({ ok: true });
    mockWorkerSession();

    const response = await postWorkerKill("", {
      authorization: "",
    });
    expect(response.status).toBe(403);
    expect(killSubagentRunAdminMock).not.toHaveBeenCalled();
  });

  it("uses requester ownership checks when a requester session header is provided without admin bypass", async () => {
    allowRemoteRequesterKill();
    getLatestSubagentRunByChildSessionKeyMock.mockReturnValue({
      runId: "run-1",
      childSessionKey: WORKER_SESSION_KEY,
    });
    killControlledSubagentRunMock.mockResolvedValue({ status: "ok" });

    const response = await postWorkerKill("", REQUESTER_WRITE_HEADERS);
    await expectRequesterKillResponse(response, true);
    expect(resolveSubagentControllerMock).toHaveBeenCalledWith({
      cfg,
      agentSessionKey: "agent:main:main",
    });
    expect(getLatestSubagentRunByChildSessionKeyMock).toHaveBeenCalledWith(WORKER_SESSION_KEY);
    expect(killSubagentRunAdminMock).not.toHaveBeenCalled();
  });

  it("uses the newest child-session row for requester-owned kills when stale rows still exist", async () => {
    allowRemoteRequesterKill();
    getLatestSubagentRunByChildSessionKeyMock.mockReturnValue({
      runId: "run-current-ended",
      childSessionKey: WORKER_SESSION_KEY,
      endedAt: Date.now() - 1,
    });
    killControlledSubagentRunMock.mockResolvedValue({ status: "done" });

    const response = await postWorkerKill("", REQUESTER_WRITE_HEADERS);
    await expectRequesterKillResponse(response, false);
    expect(killControlledSubagentRunMock).toHaveBeenCalledTimes(1);
    const killCall = killControlledSubagentRunMock.mock.calls.at(0)?.[0] as
      | {
          cfg?: unknown;
          controller?: { controllerSessionKey?: string };
          entry?: { runId?: string; childSessionKey?: string };
        }
      | undefined;
    expect(killCall?.cfg).toBe(cfg);
    expect(killCall?.controller?.controllerSessionKey).toBe("agent:main:main");
    expect(killCall?.entry?.runId).toBe("run-current-ended");
    expect(killCall?.entry?.childSessionKey).toBe(WORKER_SESSION_KEY);
  });

  it("rejects bearer-auth requester kills without a trusted write scope surface", async () => {
    isLocalDirectRequestMock.mockReturnValue(false);
    const response = await post(
      "/sessions/agent%3Amain%3Asubagent%3Aworker/kill",
      TEST_GATEWAY_TOKEN,
      { "x-openclaw-requester-session-key": "agent:other:main" },
    );
    expect(response.status).toBe(403);
    expectErrorResponse(await response.json(), {
      type: "forbidden",
      message: "missing scope: operator.write",
    });
    expect(loadSessionEntryMock).not.toHaveBeenCalled();
    expect(killSubagentRunAdminMock).not.toHaveBeenCalled();
    expect(killControlledSubagentRunMock).not.toHaveBeenCalled();
  });
});
