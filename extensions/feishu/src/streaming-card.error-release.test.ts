// Feishu streaming card tests exercise error-path response body cancellation
// through a real guarded HTTP transport against a loopback server.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loopback = vi.hoisted(() => ({
  baseUrl: "",
  releases: [] as Array<{ bodyIsNull: boolean; bodyUsed: boolean }>,
  authStatus: 200,
  createStatus: 200,
  settingsStatus: 200,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: async (...args: Parameters<typeof actual.fetchWithSsrFGuard>) => {
      const [params] = args;
      const url = new URL(params.url);
      const redirected = new URL(`${url.pathname}${url.search}`, loopback.baseUrl).toString();
      const guarded = await actual.fetchWithSsrFGuard({
        ...params,
        policy: { allowPrivateNetwork: true },
        url: redirected,
      });
      return {
        ...guarded,
        release: async () => {
          loopback.releases.push({
            bodyIsNull: guarded.response.body === null,
            bodyUsed: guarded.response.bodyUsed,
          });
          await guarded.release();
        },
      };
    },
  };
});

const { FeishuStreamingSession } = await import("./streaming-card.js");

function writeJson(res: import("node:http").ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.includes("/auth/")) {
      if (loopback.authStatus === 200) {
        writeJson(res, { code: 0, msg: "ok", tenant_access_token: "token", expire: 3600 });
      } else {
        writeJson(res, { error: "tenant token rejected" }, loopback.authStatus);
      }
      return;
    }
    if (url.pathname.endsWith("/settings")) {
      if (loopback.settingsStatus === 200) {
        writeJson(res, { code: 0, msg: "ok" });
      } else {
        writeJson(res, { error: "settings rejected" }, loopback.settingsStatus);
      }
      return;
    }
    if (loopback.createStatus === 200) {
      writeJson(res, { code: 0, msg: "ok", data: { card_id: "card_1" } });
    } else {
      writeJson(res, { error: "card create rejected" }, loopback.createStatus);
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  loopback.baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

beforeEach(() => {
  loopback.releases = [];
  loopback.authStatus = 200;
  loopback.createStatus = 200;
  loopback.settingsStatus = 200;
});

describe("feishu streaming card error-path body release", () => {
  it("cancels the unread tenant-token error body before release", async () => {
    loopback.authStatus = 500;
    const session = new FeishuStreamingSession({} as never, {
      appId: "app_error_token",
      appSecret: "secret",
    });

    await expect(session.start("chat_id", "open_id")).rejects.toThrow(
      "Token request failed with HTTP 500",
    );

    expect(loopback.releases).toEqual([{ bodyIsNull: false, bodyUsed: true }]);
  });

  it("cancels the unread create-card error body before release", async () => {
    loopback.createStatus = 500;
    const session = new FeishuStreamingSession({} as never, {
      appId: "app_error_create",
      appSecret: "secret",
    });

    await expect(session.start("chat_id", "open_id")).rejects.toThrow(
      "Create card request failed with HTTP 500",
    );

    expect(loopback.releases).toEqual([
      { bodyIsNull: false, bodyUsed: true },
      { bodyIsNull: false, bodyUsed: true },
    ]);
  });

  it("cancels the unread close-settings error body before release", async () => {
    const client = {
      im: {
        message: {
          create: async () => ({ code: 0, data: { message_id: "msg_1" } }),
        },
      },
    };
    const session = new FeishuStreamingSession(client as never, {
      appId: "app_error_close",
      appSecret: "secret",
    });
    await session.start("chat_id", "open_id");
    loopback.settingsStatus = 500;

    await expect(session.closeWithResult()).rejects.toMatchObject({
      name: "FeishuStreamingFinalizationError",
      result: { visibleReplySent: false },
    });

    expect(loopback.releases).toEqual([
      { bodyIsNull: false, bodyUsed: true },
      { bodyIsNull: false, bodyUsed: true },
      { bodyIsNull: false, bodyUsed: true },
    ]);
  });
});
