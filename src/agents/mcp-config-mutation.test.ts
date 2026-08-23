import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  setConfiguredMcpServer,
  unsetConfiguredMcpServer,
  updateConfiguredMcpServer,
  updateConfiguredMcpServerTools,
} from "./mcp-config-mutation.js";
import { operatorMcpOAuthIdentity, requesterMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import {
  readMcpOAuthPendingAuthorization,
  readMcpOAuthStore,
  updateMcpOAuthStore,
  writeMcpOAuthPendingAuthorization,
} from "./mcp-oauth-store.js";

const SERVER_URL = "https://mcp.example.com/rpc";
const PER_REQUESTER_SERVER = {
  url: SERVER_URL,
  transport: "streamable-http",
  auth: "oauth",
  oauth: { identity: "per-requester" },
};

function seedOAuthState(name: string) {
  const operator = operatorMcpOAuthIdentity(name, SERVER_URL);
  const requester = requesterMcpOAuthIdentity(name, SERVER_URL, {
    requesterSenderId: "alice",
    messageChannel: "telegram",
  });
  for (const identity of [operator, requester]) {
    updateMcpOAuthStore(identity.storeKey, (store) => ({
      ...store,
      tokens: { access_token: identity.principal, token_type: "Bearer" },
    }));
    writeMcpOAuthPendingAuthorization(identity.storeKey, `${identity.principal}-state`);
  }
  return { operator, requester };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

async function withMcpConfigHome(run: () => Promise<void>): Promise<void> {
  await withTempHome(
    async () => {
      closeOpenClawStateDatabaseForTest();
      try {
        await run();
      } finally {
        closeOpenClawStateDatabaseForTest();
      }
    },
    {
      prefix: "openclaw-mcp-config-oauth-",
      skipSessionCleanup: true,
      env: {
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_STATE_DIR: (home) => path.join(home, ".openclaw"),
      },
    },
  );
}

describe("configured MCP OAuth cleanup", () => {
  it.each([
    {
      name: "set replacement",
      mutate: (serverName: string) =>
        setConfiguredMcpServer({
          name: serverName,
          server: { command: "uvx", args: ["replacement-mcp"] },
        }),
      expected: { operator: undefined, requester: undefined },
    },
    {
      name: "unset",
      mutate: (serverName: string) => unsetConfiguredMcpServer({ name: serverName }),
      expected: { operator: undefined, requester: undefined },
    },
    {
      name: "identity flip",
      mutate: (serverName: string) =>
        updateConfiguredMcpServer({
          name: serverName,
          update: (server) => ({ ...server, oauth: {} }),
        }),
      expected: { operator: "operator", requester: undefined },
    },
    {
      name: "tool update",
      mutate: (serverName: string) =>
        updateConfiguredMcpServerTools({
          name: serverName,
          tools: { include: ["search"] },
        }),
      expected: { operator: "operator", requester: "requester" },
    },
  ])("applies cleanup after $name", async ({ mutate, expected }) => {
    await withMcpConfigHome(async () => {
      const serverName = "fixture";
      const initial = await setConfiguredMcpServer({
        name: serverName,
        server: PER_REQUESTER_SERVER,
      });
      expect(initial.ok).toBe(true);
      const { operator, requester } = seedOAuthState(serverName);

      const result = await mutate(serverName);

      expect(result.ok).toBe(true);
      expect(readMcpOAuthStore(operator.storeKey).tokens?.access_token).toBe(expected.operator);
      expect(readMcpOAuthStore(requester.storeKey).tokens?.access_token).toBe(expected.requester);
      expect(readMcpOAuthPendingAuthorization("operator-state")).toBe(
        expected.operator ? operator.storeKey : undefined,
      );
      expect(readMcpOAuthPendingAuthorization("requester-state")).toBe(
        expected.requester ? requester.storeKey : undefined,
      );
    });
  });
});
