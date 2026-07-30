import fs from "node:fs/promises";
import nodePath from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { drainSystemEvents } from "../infra/system-events.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  cronIsolatedRun,
  installGatewayTestHooks,
  testState,
  withGatewayServer,
  waitForSystemEvent,
} from "./test-helpers.js";
import { setTestPluginRegistry } from "./test-helpers.plugin-registry.js";

installGatewayTestHooks({ scope: "suite" });

await import("./server.js");

const HOOK_TOKEN = "hook-secret";

afterEach(() => {
  drainSystemEvents(resolveMainSessionKeyFromConfig());
  vi.restoreAllMocks();
});

async function postHook(
  port: number,
  path: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HOOK_TOKEN}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function waitForCronRuns(count: number): Promise<void> {
  await expect
    .poll(() => cronIsolatedRun.mock.calls.length, { timeout: 2_000, interval: 10 })
    .toBe(count);
}

function cronRunCall(index = 0): {
  sessionKey?: string;
  job?: { sessionTarget?: string; delivery?: { accountId?: string } };
} {
  const call = cronIsolatedRun.mock.calls.at(index)?.[0];
  if (!call || typeof call !== "object") {
    throw new Error(`expected cron isolated run call ${index + 1}`);
  }
  return call;
}

function mockRunsOk(): void {
  cronIsolatedRun.mockClear();
  cronIsolatedRun.mockResolvedValue({ status: "ok", summary: "done" });
}

async function writeHookTransformModule(moduleName: string, source: string): Promise<void> {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH is required");
  }
  const transformsDir = nodePath.join(nodePath.dirname(configPath), "hooks", "transforms");
  await fs.mkdir(transformsDir, { recursive: true });
  await fs.writeFile(nodePath.join(transformsDir, moduleName), source, "utf-8");
}

describe("gateway hook session mode", () => {
  test("keeps isolated as the default and requires bounded keys for direct persistence", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowedSessionKeyPrefixes: ["hook:"],
    };
    await withGatewayServer(async ({ port }) => {
      mockRunsOk();
      const isolated = await postHook(port, "/hooks/agent", { message: "Fresh context" });
      expect(isolated.status).toBe(200);
      await waitForCronRuns(1);
      expect(cronRunCall().job?.sessionTarget).toBe("isolated");
      await waitForSystemEvent();

      const missingKey = await postHook(port, "/hooks/agent", {
        message: "Remember this",
        sessionMode: "persistent",
      });
      expect(missingKey.status).toBe(400);
      expect(await missingKey.json()).toMatchObject({
        error: "sessionKey is required when sessionMode is persistent",
      });

      const disabledRequestKeys = await postHook(port, "/hooks/agent", {
        message: "Remember this",
        sessionKey: "hook:direct:42",
        sessionMode: "persistent",
      });
      expect(disabledRequestKeys.status).toBe(400);
      expect(await disabledRequestKeys.json()).toMatchObject({
        error: expect.stringContaining("hooks.allowRequestSessionKey"),
      });
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
    });

    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: [],
    };
    await withGatewayServer(async ({ port }) => {
      cronIsolatedRun.mockClear();
      const unbounded = await postHook(port, "/hooks/agent", {
        message: "Remember this",
        sessionKey: "hook:direct:42",
        sessionMode: "persistent",
      });
      expect(unbounded.status).toBe(400);
      expect(await unbounded.json()).toMatchObject({
        error: expect.stringContaining("hooks.allowedSessionKeyPrefixes"),
      });
      expect(cronIsolatedRun).not.toHaveBeenCalled();
    });

    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:"],
    };
    await withGatewayServer(async ({ port }) => {
      mockRunsOk();
      const accepted = await postHook(port, "/hooks/agent", {
        message: "Remember this",
        sessionKey: "hook:direct:42",
        sessionMode: "persistent",
      });
      expect(accepted.status).toBe(200);
      await waitForCronRuns(1);
      expect(cronRunCall().sessionKey).toBe("hook:direct:42");
      expect(cronRunCall().job?.sessionTarget).toBe("session:hook:direct:42");
      await waitForSystemEvent();
    });
  });

  test("requires stable keys for mapped persistent hooks", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      defaultSessionKey: "hook:mapped:default",
      mappings: [
        {
          match: { path: "mapped-static" },
          action: "agent",
          messageTemplate: "Static",
          sessionKey: "hook:mapped:static",
          sessionMode: "persistent",
        },
        {
          match: { path: "mapped-default" },
          action: "agent",
          messageTemplate: "Default",
          sessionMode: "persistent",
        },
      ],
    };
    await withGatewayServer(async ({ port }) => {
      mockRunsOk();
      const staticResponse = await postHook(port, "/hooks/mapped-static", {});
      expect(staticResponse.status).toBe(200);
      await waitForCronRuns(1);
      expect(cronRunCall(0).job?.sessionTarget).toBe("session:hook:mapped:static");
      await waitForSystemEvent();

      const defaultResponse = await postHook(port, "/hooks/mapped-default", {});
      expect(defaultResponse.status).toBe(200);
      await waitForCronRuns(2);
      expect(cronRunCall(1).job?.sessionTarget).toBe("session:hook:mapped:default");
      await waitForSystemEvent();
    });

    cronIsolatedRun.mockClear();
    await writeHookTransformModule("mapped-missing-key.mjs", "export default () => ({});");
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      mappings: [
        {
          match: { path: "mapped-missing" },
          action: "agent",
          messageTemplate: "Missing",
          sessionMode: "persistent",
          transform: { module: "mapped-missing-key.mjs" },
        },
      ],
    };
    await withGatewayServer(async ({ port }) => {
      const missing = await postHook(port, "/hooks/mapped-missing", {});
      expect(missing.status).toBe(400);
      expect(await missing.json()).toMatchObject({
        error: expect.stringContaining("sessionKey or hooks.defaultSessionKey"),
      });
      expect(cronIsolatedRun).not.toHaveBeenCalled();
    });
  });

  test("keeps session mode in the idempotency dispatch scope", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:"],
    };
    await withGatewayServer(async ({ port }) => {
      mockRunsOk();
      const headers = { "Idempotency-Key": "hook-idem-session-mode" };
      const basePayload = {
        message: "Do it",
        name: "Email",
        sessionKey: "hook:mode:42",
      };
      const isolated = await postHook(
        port,
        "/hooks/agent",
        { ...basePayload, sessionMode: "isolated" },
        headers,
      );
      expect(isolated.status).toBe(200);
      const persistent = await postHook(
        port,
        "/hooks/agent",
        { ...basePayload, sessionMode: "persistent" },
        headers,
      );
      expect(persistent.status).toBe(200);
      await waitForCronRuns(2);

      expect(cronRunCall(0).job?.sessionTarget).toBe("isolated");
      expect(cronRunCall(1).job?.sessionTarget).toBe("session:hook:mode:42");
    });
  });

  test("keeps account id in the idempotency dispatch scope", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
    };
    await withGatewayServer(async ({ port }) => {
      setTestPluginRegistry(
        createTestRegistry([
          {
            pluginId: "discord",
            source: "test",
            plugin: createChannelTestPluginBase({
              id: "discord",
              config: {
                listAccountIds: () => ["work", "personal"],
                resolveAccount: (_cfg, accountId) => ({ accountId }),
              },
            }),
          },
        ]),
      );
      mockRunsOk();
      const headers = { "Idempotency-Key": "hook-idem-account-id" };
      const basePayload = {
        message: "Do it",
        channel: "discord",
        to: "channel-1",
      };
      const work = await postHook(
        port,
        "/hooks/agent",
        { ...basePayload, accountId: "work" },
        headers,
      );
      expect(work.status).toBe(200);
      const personal = await postHook(
        port,
        "/hooks/agent",
        { ...basePayload, accountId: "personal" },
        headers,
      );
      expect(personal.status).toBe(200);
      await waitForCronRuns(2);

      expect(cronRunCall(0).job?.delivery?.accountId).toBe("work");
      expect(cronRunCall(1).job?.delivery?.accountId).toBe("personal");
    });
  });
});
