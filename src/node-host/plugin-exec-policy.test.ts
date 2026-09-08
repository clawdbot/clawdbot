import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { saveExecApprovals, type ExecAsk, type ExecSecurity } from "../infra/exec-approvals.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { invokeRegisteredNodeHostCommand } from "./plugin-node-host.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "node-plugin-exec-policy-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  setRuntimeConfigSnapshot({});
  saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" } });
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function launch(source: "session-full" | "human-approved", whilePreparing: () => void = () => {}) {
  const spawn = vi.fn();
  const controller = new AbortController();
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(
    createPluginRecord({
      id: "fixture",
      source: "fixture",
      origin: "bundled",
      enabled: true,
      configSchema: true,
    }),
  );
  registry.nodeHostCommands.push({
    pluginId: "fixture",
    pluginName: "Fixture",
    source: "fixture",
    command: {
      command: "fixture.exec",
      dangerous: true,
      handle: async (_params, _io, context) => {
        const assertAuthorized = context!.prepareExecAuthorization!(source);
        await Promise.resolve();
        whilePreparing();
        assertAuthorized();
        spawn();
        return "{}";
      },
    },
  });
  setActivePluginRegistry(registry);
  const result = invokeRegisteredNodeHostCommand("fixture.exec", "{}", undefined, {
    sendNodeEvent: async () => undefined,
    sessionKey: "agent:main:session",
    signal: controller.signal,
  });
  return { result, spawn, controller, registry };
}

function setPolicy(owner: "config" | "approvals", security: ExecSecurity, ask: ExecAsk) {
  if (owner === "config") {
    setRuntimeConfigSnapshot({ tools: { exec: { security, ask } } });
  } else {
    saveExecApprovals({ version: 1, defaults: { security, ask } });
  }
}

describe("plugin node execution authorization", () => {
  it.each(["config", "approvals"] as const)(
    "keeps %s restrictions for Full and explicit human decisions",
    async (owner) => {
      for (const security of ["full", "allowlist", "deny"] as const) {
        for (const ask of ["off", "on-miss", "always"] as const) {
          for (const source of ["session-full", "human-approved"] as const) {
            setPolicy(owner, security, ask);
            const { result, spawn } = launch(source);
            const allowed =
              source === "human-approved"
                ? security !== "deny"
                : security === "full" && ask === "off";
            if (allowed) {
              await expect(result).resolves.toBe("{}");
              expect(spawn).toHaveBeenCalledOnce();
            } else {
              await expect(result).rejects.toThrow();
              expect(spawn).not.toHaveBeenCalled();
            }
          }
        }
      }
    },
  );

  it.each(["config", "approvals"] as const)(
    "refuses %s tightening during awaited setup",
    async (owner) => {
      for (const source of ["session-full", "human-approved"] as const) {
        for (const [security, ask] of [
          ["deny", "off"],
          ["allowlist", "off"],
          ["full", "always"],
        ] as const) {
          setPolicy(owner, "full", "off");
          const { result, spawn } = launch(source, () => setPolicy(owner, security, ask));
          await expect(result).rejects.toThrow();
          expect(spawn).not.toHaveBeenCalled();
        }
      }
    },
  );

  it.each(["cancel", "plugin-replaced"] as const)(
    "refuses %s during awaited setup",
    async (reason) => {
      const invocation = launch("session-full", () => {
        if (reason === "cancel") {
          invocation.controller.abort();
        } else {
          setActivePluginRegistry(createEmptyPluginRegistry());
        }
      });
      await expect(invocation.result).rejects.toThrow("authority is closed");
      expect(invocation.spawn).not.toHaveBeenCalled();
    },
  );
});
