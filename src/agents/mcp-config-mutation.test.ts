import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { mcpConfigInternal } from "../config/mcp-config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  setConfiguredMcpServer,
  unsetConfiguredMcpServer,
  updateConfiguredMcpServer,
  updateConfiguredMcpServerTools,
} from "./mcp-config-mutation.js";
import { withMcpLifecycleLease } from "./mcp-lifecycle-lease.js";
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
  vi.restoreAllMocks();
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

describe("configured MCP ownership coordination", () => {
  it("waits for active Claw ownership reconciliation before an ordinary mutation", async () => {
    await withMcpConfigHome(async () => {
      const leaseEntered = createDeferred();
      const releaseLease = createDeferred();
      const order: string[] = [];
      const set = vi.spyOn(mcpConfigInternal, "set").mockImplementation(async () => ({
        ok: true,
        path: "config",
        config: {},
        mcpServers: {},
      }));
      const lifecycle = withMcpLifecycleLease("fixture", {}, async () => {
        order.push("lifecycle");
        leaseEntered.resolve();
        await releaseLease.promise;
      });
      await leaseEntered.promise;

      const mutation = setConfiguredMcpServer({
        name: " fixture ",
        server: { command: "uvx", args: ["operator-mcp"] },
      }).then((result) => {
        order.push("operator");
        return result;
      });
      await Promise.resolve();
      expect(set).not.toHaveBeenCalled();
      expect(order).toEqual(["lifecycle"]);

      releaseLease.resolve();
      await lifecycle;
      const result = await mutation;

      expect(result.ok).toBe(true);
      expect(set).toHaveBeenCalledOnce();
      expect(order).toEqual(["lifecycle", "operator"]);
    });
  });

  it("preserves the canonical validation result for an empty server name", async () => {
    await withMcpConfigHome(async () => {
      const result = await setConfiguredMcpServer({
        name: " ",
        server: { command: "uvx", args: ["operator-mcp"] },
      });

      expect(result).toEqual({
        ok: false,
        path: "",
        error: "MCP server name is required.",
      });
    });
  });
});
