/** Tests Gemini CLI bundle-MCP system settings generation. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareCliBundleMcpCaptureAttempt, prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import {
  cliBundleMcpHarness,
  cliNativeMcpPolicyContext,
  setupCliBundleMcpTestHarness,
  writeCliMcpPolicyProbeServer,
} from "./bundle-mcp.test-support.js";

setupCliBundleMcpTestHarness();

describe("prepareCliBundleMcpConfig gemini", () => {
  it("disables Gemini native web search without bundle MCP", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: false,
      mode: "gemini-system-settings",
      backend: { command: "gemini" },
      workspaceDir: "/tmp/openclaw-cli-gemini-web-search-disabled",
      toolOverrides: { webSearch: false },
    });
    const raw = JSON.parse(
      await fs.readFile(prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH as string, "utf-8"),
    ) as { tools?: { exclude?: string[] } };

    expect(raw.tools?.exclude).toEqual(["google_web_search"]);
    expect(prepared.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
    await prepared.cleanup?.();
  });

  it("writes Gemini system settings for bundle MCP servers", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "gemini-system-settings",
      backend: {
        command: "gemini",
        args: ["--prompt", "{prompt}"],
      },
      workspaceDir: "/tmp/openclaw-bundle-mcp-gemini",
      config: { plugins: { enabled: false } },
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            excludeTools: ["global_delete"],
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
              "x-openclaw-client-caps": "${OPENCLAW_MCP_CLIENT_CAPS}",
            },
          },
        },
      },
      env: {
        OPENCLAW_MCP_TOKEN: "lb-tk-123",
        OPENCLAW_MCP_CLIENT_CAPS: "tool-events,inline-widgets",
      },
      toolOverrides: { mcpToolsDeny: { openclaw: ["delete_docs"] }, webSearch: false },
    });

    expect(prepared.backend.args).toEqual(["--prompt", "{prompt}"]);
    expect(prepared.env?.OPENCLAW_MCP_TOKEN).toBe("lb-tk-123");
    expect(typeof prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe("string");
    // Gemini reads MCP servers from a generated system settings JSON file.
    const raw = JSON.parse(
      await fs.readFile(prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH as string, "utf-8"),
    ) as {
      mcp?: { allowed?: string[] };
      tools?: { exclude?: string[] };
      mcpServers?: Record<
        string,
        { url?: string; headers?: Record<string, string>; excludeTools?: string[] }
      >;
    };
    expect(raw.mcp?.allowed).toEqual(["openclaw"]);
    expect(raw.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:23119/mcp");
    expect(raw.mcpServers?.openclaw?.headers?.Authorization).toBe("Bearer lb-tk-123");
    expect(raw.mcpServers?.openclaw?.headers?.["x-openclaw-client-caps"]).toBe(
      "tool-events,inline-widgets",
    );
    expect(raw.mcpServers?.openclaw?.excludeTools).toEqual(["delete_docs", "global_delete"]);
    expect(raw.tools?.exclude).toEqual(["google_web_search"]);

    await prepared.cleanup?.();
  });

  it("projects canonical allow and deny sets into Gemini settings", async () => {
    const serverPath = await writeCliMcpPolicyProbeServer();
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      tools: { allow: ["docs__read_docs"], deny: ["docs__delete_docs"] },
      mcp: { servers: { docs: { command: process.execPath, args: [serverPath] } } },
    };
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "gemini-system-settings",
      backend: { command: "gemini" },
      workspaceDir: cliBundleMcpHarness.bundleProbeWorkspaceDir,
      config,
      nativeMcpPolicy: cliNativeMcpPolicyContext(config, "gemini-policy"),
    });
    const raw = JSON.parse(
      await fs.readFile(prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH as string, "utf-8"),
    ) as { mcpServers?: { docs?: { includeTools?: string[]; excludeTools?: string[] } } };
    expect(raw.mcpServers?.docs).toMatchObject({
      includeTools: ["read_docs"],
      excludeTools: ["app_docs", "delete_docs", "task_docs"],
    });
    await prepared.cleanup?.();
  });

  it("hides non-model MCP tools from Gemini without an explicit policy", async () => {
    const serverPath = await writeCliMcpPolicyProbeServer();
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      mcp: { servers: { docs: { command: process.execPath, args: [serverPath] } } },
    };
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "gemini-system-settings",
      backend: { command: "gemini" },
      workspaceDir: cliBundleMcpHarness.bundleProbeWorkspaceDir,
      config,
      nativeMcpPolicy: cliNativeMcpPolicyContext(config, "gemini-default-hidden"),
    });
    const raw = JSON.parse(
      await fs.readFile(prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH as string, "utf-8"),
    ) as { mcpServers?: { docs?: { includeTools?: string[]; excludeTools?: string[] } } };
    expect(raw.mcpServers?.docs).toMatchObject({
      includeTools: ["delete_docs", "read_docs"],
      excludeTools: ["app_docs", "task_docs"],
    });
    await prepared.cleanup?.();
  });

  it("omits a server when configured and policy allowlists do not overlap", async () => {
    const serverPath = await writeCliMcpPolicyProbeServer();
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "gemini-system-settings",
      backend: { command: "gemini" },
      workspaceDir: cliBundleMcpHarness.bundleProbeWorkspaceDir,
      exclusiveConfig: {
        mcpServers: {
          docs: {
            command: process.execPath,
            args: [serverPath],
            includeTools: ["legacy_only"],
            toolFilter: { include: ["read_docs"] },
          },
        },
      },
    });
    const raw = JSON.parse(
      await fs.readFile(prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH as string, "utf-8"),
    ) as { mcp?: { allowed?: string[] }; mcpServers?: Record<string, unknown> };
    expect(raw.mcp?.allowed).not.toContain("docs");
    expect(raw.mcpServers?.docs).toBeUndefined();
    await prepared.cleanup?.();
  });

  it("translates user mcp.servers transport fields in Gemini system settings", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "gemini-system-settings",
      backend: {
        command: "gemini",
        args: ["--prompt", "{prompt}"],
      },
      workspaceDir: "/tmp/openclaw-bundle-mcp-gemini",
      config: {
        plugins: { enabled: false },
        mcp: {
          servers: {
            context7: {
              transport: "streamable-http",
              url: "https://mcp.context7.com/mcp",
              headers: {
                Authorization: "Bearer ${CONTEXT7_API_KEY}",
              },
            },
          },
        },
      },
      env: {
        CONTEXT7_API_KEY: "ctx7-test",
      },
    });

    expect(prepared.env?.CONTEXT7_API_KEY).toBe("ctx7-test");
    expect(typeof prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe("string");
    // User OpenClaw transport names are normalized to Gemini's expected schema.
    const raw = JSON.parse(
      await fs.readFile(prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH as string, "utf-8"),
    ) as {
      mcp?: { allowed?: string[] };
      mcpServers?: Record<
        string,
        { type?: string; transport?: string; url?: string; headers?: Record<string, string> }
      >;
    };
    expect(raw.mcp?.allowed).toEqual(["context7"]);
    expect(raw.mcpServers?.context7?.type).toBe("http");
    expect(raw.mcpServers?.context7?.transport).toBeUndefined();
    expect(raw.mcpServers?.context7?.url).toBe("https://mcp.context7.com/mcp");
    expect(raw.mcpServers?.context7?.headers?.Authorization).toBe("Bearer ctx7-test");

    await prepared.cleanup?.();
  });

  it("writes a unique capture token into per-attempt Gemini settings", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "gemini-system-settings",
      backend: {
        command: "gemini",
        args: ["--prompt", "{prompt}"],
      },
      workspaceDir: "/tmp/openclaw-bundle-mcp-gemini",
      config: { plugins: { enabled: false } },
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            headers: {
              "x-openclaw-cli-capture-key": "${OPENCLAW_MCP_CLI_CAPTURE_KEY}",
            },
          },
        },
      },
      env: {
        OPENCLAW_MCP_CLI_CAPTURE_KEY: "",
      },
    });
    const attempt = await prepareCliBundleMcpCaptureAttempt({
      mode: "gemini-system-settings",
      env: prepared.env,
      captureKey: "attempt-123",
    });

    try {
      const raw = JSON.parse(
        await fs.readFile(attempt.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH as string, "utf-8"),
      ) as {
        mcpServers?: Record<string, { headers?: Record<string, string> }>;
      };
      expect(raw.mcpServers?.openclaw?.headers?.["x-openclaw-cli-capture-key"]).toBe("attempt-123");
      expect(attempt.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).not.toBe(
        prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH,
      );
    } finally {
      await attempt.cleanup?.();
      await prepared.cleanup?.();
    }
  });

  it("preserves inherited Gemini auth selection in generated system settings", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gemini-settings-"));
    const inheritedSettingsPath = path.join(dir, "settings.json");
    await fs.writeFile(
      inheritedSettingsPath,
      `${JSON.stringify(
        {
          security: {
            auth: {
              selectedType: "vertex-ai",
            },
            folderTrust: {
              enabled: true,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "gemini-system-settings",
      backend: {
        command: "gemini",
        args: ["--prompt", "{prompt}"],
      },
      workspaceDir: "/tmp/openclaw-bundle-mcp-gemini",
      config: { plugins: { enabled: false } },
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
          },
        },
      },
      env: {
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: inheritedSettingsPath,
      },
    });

    try {
      const raw = JSON.parse(
        await fs.readFile(prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH as string, "utf-8"),
      ) as {
        security?: {
          auth?: { selectedType?: string };
          folderTrust?: { enabled?: boolean };
        };
      };
      expect(raw.security?.auth?.selectedType).toBe("vertex-ai");
      expect(raw.security?.folderTrust?.enabled).toBe(true);
      expect(prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).not.toBe(inheritedSettingsPath);
    } finally {
      await prepared.cleanup?.();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
