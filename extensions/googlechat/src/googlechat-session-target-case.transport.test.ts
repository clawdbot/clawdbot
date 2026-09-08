import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const loopback = vi.hoisted(() => ({ baseUrl: "" }));
const requests = vi.hoisted(() => [] as Array<{ method: string; path: string; body: string }>);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    // Keep the real guarded fetch; only send it at the loopback origin.
    fetchWithSsrFGuard: async (...args: Parameters<typeof actual.fetchWithSsrFGuard>) => {
      const [params] = args;
      return await actual.fetchWithSsrFGuard({
        ...params,
        url: params.url.replace("https://chat.googleapis.com", loopback.baseUrl),
        policy: { allowPrivateNetwork: true },
      });
    },
  };
});

vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  getGoogleChatAccessToken: vi.fn(async () => "transport-proof-token"),
}));

import { googlechatPlugin } from "../api.js";

const CANONICAL_SPACE = "spaces/AAQA1bC2dEf";
const FOLDED_SPACE = "spaces/aaqa1bc2def";
const SESSION_KEY = `agent:main:googlechat:group:${FOLDED_SPACE}`;

let server: Server;

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => {
      const path = request.url ?? "";
      requests.push({
        method: request.method ?? "",
        path,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "content-type": "application/json" });
      if (request.method === "POST" && path.includes("/messages")) {
        const space = path.replace(/^\/v1\//, "").replace(/\/messages.*$/, "");
        response.end(JSON.stringify({ name: `${space}/messages/proof-1` }));
        return;
      }
      response.end(JSON.stringify({ name: path.replace(/^\/v1\//, ""), spaceType: "SPACE" }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  loopback.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  setActivePluginRegistry(createTestRegistry([]));
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

describe("session-derived Google Chat delivery", () => {
  it("delivers to the canonical mixed-case space recorded by the session", async () => {
    await withOpenClawTestState({ prefix: "googlechat-session-target-" }, async (state) => {
      const config: OpenClawConfig = {
        agents: { entries: { main: { default: true, workspace: state.workspaceDir } } },
        channels: {
          googlechat: {
            accounts: {
              default: {
                serviceAccount:
                  '{"client_email":"proof@example.iam.gserviceaccount.com","private_key":"proof-key"}',
              },
            },
          },
        },
      };

      // The session recorded its canonical destination on the inbound turn.
      await upsertSessionEntry({
        agentId: "main",
        env: process.env,
        sessionKey: SESSION_KEY,
        entry: {
          sessionId: "proof-session",
          updatedAt: Date.now(),
          delivery: {
            kind: "external",
            route: { channel: "googlechat", target: { to: `googlechat:${CANONICAL_SPACE}` } },
            context: { channel: "googlechat", to: `googlechat:${CANONICAL_SPACE}` },
            origin: { provider: "googlechat", to: `googlechat:${CANONICAL_SPACE}` },
          },
        },
      });

      setActivePluginRegistry(
        createTestRegistry([
          { pluginId: "googlechat", source: "test", origin: "bundled", plugin: googlechatPlugin },
        ]),
      );

      requests.length = 0;

      // The ambient surface is webchat; the destination exists only in the folded session
      // key and in the session's stored delivery metadata.
      const tools = createOpenClawCodingTools({
        config,
        agentId: "main",
        sessionKey: SESSION_KEY,
        sessionId: "proof-session",
        messageProvider: "webchat",
        workspaceDir: state.workspaceDir,
      });
      const tool = tools.find((entry) => entry.name === "message");
      expect(tool, "message tool present in the harness tool list").toBeDefined();

      // No explicit target: the tool must derive the destination from the session.
      const result = await tool!.execute("proof-1", {
        action: "send",
        message: "session-derived reply",
      });

      const sends = requests.filter((entry) => entry.method === "POST");
      expect(result.details).toMatchObject({ ok: true, to: CANONICAL_SPACE });
      expect(sends).toHaveLength(1);
      expect(sends[0]?.path).toBe(`/v1/${CANONICAL_SPACE}/messages`);
      expect(JSON.parse(sends[0]!.body)).toEqual({ text: "session-derived reply" });
    });
  }, 60_000);
});
