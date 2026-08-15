// Codex tests cover private binding connection selection.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { createCodexCatalogHomeResolver } from "../session-catalog-homes.js";
import { resolveCodexAppServerHomeDir } from "./auth-start-options.js";
import {
  requireCodexSupervisionModelSelection,
  resolveCodexBindingAppServerConnection,
} from "./binding-connection.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";

function supervisedBinding(pluginConfig: unknown, agentDir?: string) {
  return {
    connectionScope: "supervision" as const,
    appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
      resolveCodexSupervisionAppServerRuntimeOptions({
        pluginConfig,
        env: {},
        requirementsToml: null,
      }),
      agentDir,
    ),
  };
}

describe("Codex binding app-server connection", () => {
  it("preserves ordinary harness runtime and auth ownership", () => {
    const connection = resolveCodexBindingAppServerConnection({
      binding: {},
      authProfileId: "openai:work",
      env: {},
      requirementsToml: null,
    });

    expect(connection.appServer.start.homeScope).toBe("agent");
    expect(connection.usesSupervisionConnection).toBe(false);
    expect(connection.requestAuthProfileId).toBe("openai:work");
    expect(connection.clientAuthProfileId).toBe("openai:work");
  });

  it("uses native user-home auth only for an enabled supervised binding", () => {
    const connection = resolveCodexBindingAppServerConnection({
      binding: supervisedBinding({ supervision: { enabled: true } }),
      authProfileId: "openai:work",
      pluginConfig: { supervision: { enabled: true } },
      env: {},
      requirementsToml: null,
    });

    expect(connection.appServer.start.homeScope).toBe("user");
    expect(connection.usesSupervisionConnection).toBe(true);
    expect(connection.requestAuthProfileId).toBeUndefined();
    expect(connection.clientAuthProfileId).toBeNull();
  });

  it("recovers the exact secondary Codex home recorded by a supervised binding", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-binding-home-")),
    );
    try {
      const alphaAgentDir = path.join(root, "agents", "alpha", "agent");
      const betaAgentDir = path.join(root, "agents", "beta", "agent");
      const processCodexHome = path.join(root, "process-codex-home");
      const alphaCodexHome = resolveCodexAppServerHomeDir(alphaAgentDir);
      await Promise.all(
        [processCodexHome, alphaCodexHome, resolveCodexAppServerHomeDir(betaAgentDir)].map((dir) =>
          fs.mkdir(dir, { recursive: true }),
        ),
      );
      const config = {
        agents: {
          ownership: "explicit",
          list: [
            { id: "alpha", agentDir: alphaAgentDir },
            { id: "beta", agentDir: betaAgentDir },
          ],
        },
      } as OpenClawConfig;
      const env = { ...process.env, CODEX_HOME: processCodexHome };
      const source = createCodexCatalogHomeResolver({
        config,
        getRuntimeConfig: () => config,
        getPluginConfig: () => ({ supervision: { enabled: true } }),
        env,
      })
        .forAgent("beta")
        .find((home) => home.appServer.start.env?.CODEX_HOME === alphaCodexHome);
      expect(source).toBeDefined();
      const fingerprint = buildCodexAppServerConnectionFingerprint(source!.appServer, betaAgentDir);

      const connection = resolveCodexBindingAppServerConnection({
        binding: {
          connectionScope: "supervision",
          appServerRuntimeFingerprint: fingerprint,
        },
        pluginConfig: { supervision: { enabled: true } },
        config,
        agentDir: betaAgentDir,
        env,
        requirementsToml: null,
      });

      expect(connection.appServer.start.env?.CODEX_HOME).toBe(alphaCodexHome);
      expect(buildCodexAppServerConnectionFingerprint(connection.appServer, betaAgentDir)).toBe(
        fingerprint,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("requires the exact native model pair for materialized supervised requests", () => {
    expect(
      requireCodexSupervisionModelSelection({
        connectionScope: "supervision",
        model: " gpt-5.5 ",
        modelProvider: " openai ",
      }),
    ).toEqual({ model: "gpt-5.5", modelProvider: "openai" });

    expect(() =>
      requireCodexSupervisionModelSelection({
        connectionScope: "supervision",
        model: "gpt-5.5",
      }),
    ).toThrow("missing its native model and provider");
  });

  it("preserves an explicit supervised WebSocket endpoint while selecting native auth", () => {
    const agentDir = path.join(os.tmpdir(), "openclaw-websocket-agent");
    const config = {
      agents: { list: [{ id: "main", agentDir, default: true }] },
    } as OpenClawConfig;
    const pluginConfig = {
      supervision: { enabled: true },
      appServer: { transport: "websocket", url: "ws://127.0.0.1:4500" },
    };
    createCodexCatalogHomeResolver({
      config,
      getRuntimeConfig: () => config,
      getPluginConfig: () => pluginConfig,
      env: {},
    });
    const connection = resolveCodexBindingAppServerConnection({
      binding: supervisedBinding(pluginConfig, agentDir),
      pluginConfig,
      config,
      agentDir,
      env: {},
      requirementsToml: null,
    });

    expect(connection.appServer.start).toMatchObject({
      transport: "websocket",
      homeScope: "agent",
      url: "ws://127.0.0.1:4500",
    });
    expect(connection.clientAuthProfileId).toBeNull();
  });

  it("fails closed when a supervised binding remains after supervision is disabled", () => {
    expect(() =>
      resolveCodexBindingAppServerConnection({
        binding: { connectionScope: "supervision" },
        pluginConfig: { supervision: { enabled: false } },
        env: {},
        requirementsToml: null,
      }),
    ).toThrow("Codex supervision is disabled");
  });

  it("fails closed when a supervised binding connection changes", () => {
    const binding = supervisedBinding({
      supervision: { enabled: true },
      appServer: { transport: "websocket", url: "ws://127.0.0.1:4500" },
    });

    expect(() =>
      resolveCodexBindingAppServerConnection({
        binding,
        pluginConfig: {
          supervision: { enabled: true },
          appServer: { transport: "websocket", url: "ws://127.0.0.1:4600" },
        },
        env: {},
        requirementsToml: null,
      }),
    ).toThrow("supervision connection changed");
  });
});
