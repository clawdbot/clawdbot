import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  CODEX_APP_SERVER_CONFIG_KEYS,
  codexAppServerStartOptionsKey,
  readCodexPluginConfig,
  resolveCodexAppServerRuntimeOptions,
} from "./config.js";

describe("Codex app-server config", () => {
  it("parses typed plugin config before falling back to environment knobs", () => {
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: {
        appServer: {
          mode: "guardian",
          transport: "websocket",
          url: "ws://127.0.0.1:39175",
          headers: { "X-Test": "yes" },
          approvalPolicy: "on-request",
          sandbox: "danger-full-access",
          approvalsReviewer: "guardian_subagent",
          serviceTier: "flex",
        },
      },
      env: {
        OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY: "never",
        OPENCLAW_CODEX_APP_SERVER_SANDBOX: "read-only",
      },
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "on-request",
        sandbox: "danger-full-access",
        approvalsReviewer: "guardian_subagent",
        serviceTier: "flex",
        start: expect.objectContaining({
          transport: "websocket",
          url: "ws://127.0.0.1:39175",
          headers: { "X-Test": "yes" },
        }),
      }),
    );
  });

  it("drops invalid legacy service tiers without discarding the rest of the config", () => {
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: {
        appServer: {
          mode: "guardian",
          approvalPolicy: "on-request",
          sandbox: "read-only",
          serviceTier: "priority",
        },
      },
      env: {},
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "on-request",
        sandbox: "read-only",
        approvalsReviewer: "auto_review",
      }),
    );
    expect(runtime).not.toHaveProperty("serviceTier");
  });

  it("rejects malformed plugin config instead of treating freeform strings as control values", () => {
    expect(
      readCodexPluginConfig({
        appServer: {
          approvalPolicy: "always",
        },
      }),
    ).toEqual({});
  });

  it("requires a websocket url when websocket transport is configured", () => {
    expect(() =>
      resolveCodexAppServerRuntimeOptions({
        pluginConfig: { appServer: { transport: "websocket" } },
        env: {},
      }),
    ).toThrow("appServer.url is required");
  });

  it("defaults native Codex approvals to unchained local execution", () => {
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: {},
      env: {},
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
        start: expect.objectContaining({
          command: "codex",
          commandSource: "managed",
        }),
      }),
    );
  });

  it("treats configured and environment commands as explicit overrides", () => {
    expect(
      resolveCodexAppServerRuntimeOptions({
        pluginConfig: { appServer: { command: "/opt/codex/bin/codex" } },
        env: { OPENCLAW_CODEX_APP_SERVER_BIN: "/usr/local/bin/codex" },
      }).start,
    ).toEqual(
      expect.objectContaining({
        command: "/opt/codex/bin/codex",
        commandSource: "config",
      }),
    );

    expect(
      resolveCodexAppServerRuntimeOptions({
        pluginConfig: {},
        env: { OPENCLAW_CODEX_APP_SERVER_BIN: "/usr/local/bin/codex" },
      }).start,
    ).toEqual(
      expect.objectContaining({
        command: "/usr/local/bin/codex",
        commandSource: "env",
      }),
    );
  });

  it("allows plugin config to opt in to guardian-reviewed local execution", () => {
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: {
        appServer: {
          mode: "guardian",
        },
      },
      env: {},
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
      }),
    );
  });

  it("allows environment mode fallback to opt in to guardian-reviewed local execution", () => {
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: {},
      env: { OPENCLAW_CODEX_APP_SERVER_MODE: "guardian" },
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
      }),
    );
  });

  it("accepts the latest auto_review reviewer and legacy guardian_subagent alias", () => {
    expect(
      resolveCodexAppServerRuntimeOptions({
        pluginConfig: { appServer: { approvalsReviewer: "auto_review" } },
        env: {},
      }).approvalsReviewer,
    ).toBe("auto_review");
    expect(
      resolveCodexAppServerRuntimeOptions({
        pluginConfig: { appServer: { approvalsReviewer: "guardian_subagent" } },
        env: {},
      }).approvalsReviewer,
    ).toBe("guardian_subagent");
  });

  it("ignores removed OPENCLAW_CODEX_APP_SERVER_GUARDIAN fallback", () => {
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: {},
      env: { OPENCLAW_CODEX_APP_SERVER_GUARDIAN: "1" },
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      }),
    );
  });

  it("lets explicit policy fields override guardian mode", () => {
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: {
        appServer: {
          mode: "guardian",
          approvalPolicy: "on-failure",
          sandbox: "danger-full-access",
          approvalsReviewer: "user",
        },
      },
      env: {},
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        approvalPolicy: "on-failure",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      }),
    );
  });

  it("derives distinct shared-client keys for distinct auth tokens without exposing them", () => {
    const first = codexAppServerStartOptionsKey({
      transport: "websocket",
      command: "codex",
      args: [],
      url: "ws://127.0.0.1:39175",
      authToken: "tok_first",
      headers: {},
    });
    const second = codexAppServerStartOptionsKey({
      transport: "websocket",
      command: "codex",
      args: [],
      url: "ws://127.0.0.1:39175",
      authToken: "tok_second",
      headers: {},
    });

    expect(first).not.toEqual(second);
    expect(first).not.toContain("tok_first");
    expect(second).not.toContain("tok_second");
  });

  it("keeps runtime config keys aligned with manifest schema and UI hints", async () => {
    const manifest = JSON.parse(
      await fs.readFile(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      configSchema: {
        properties: {
          appServer: { properties: Record<string, unknown> };
        };
      };
      uiHints: Record<string, unknown>;
    };
    const manifestKeys = Object.keys(
      manifest.configSchema.properties.appServer.properties,
    ).toSorted();

    expect(manifestKeys).toEqual([...CODEX_APP_SERVER_CONFIG_KEYS].toSorted());
    for (const key of CODEX_APP_SERVER_CONFIG_KEYS) {
      expect(manifest.uiHints[`appServer.${key}`]).toBeTruthy();
    }
  });

  it("does not schema-default mode-derived policy fields", async () => {
    const manifest = JSON.parse(
      await fs.readFile(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      configSchema: {
        properties: {
          appServer: {
            properties: Record<string, { default?: unknown }>;
          };
        };
      };
    };
    const appServerProperties = manifest.configSchema.properties.appServer.properties;

    expect(appServerProperties.command?.default).toBeUndefined();
    expect(appServerProperties.approvalPolicy?.default).toBeUndefined();
    expect(appServerProperties.sandbox?.default).toBeUndefined();
    expect(appServerProperties.approvalsReviewer?.default).toBeUndefined();
  });
});
