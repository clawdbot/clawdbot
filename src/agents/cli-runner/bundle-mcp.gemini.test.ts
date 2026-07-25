/** Tests Gemini CLI bundle-MCP system settings generation. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareCliBundleMcpCaptureAttempt, prepareCliBundleMcpConfig } from "./bundle-mcp.js";

describe("prepareCliBundleMcpConfig gemini", () => {
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
    });

    expect(prepared.backend.args).toEqual(["--prompt", "{prompt}"]);
    expect(prepared.env?.OPENCLAW_MCP_TOKEN).toBe("lb-tk-123");
    expect(typeof prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe("string");
    // Gemini reads MCP servers from a generated system settings JSON file.
    const raw = JSON.parse(
      await fs.readFile(prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH as string, "utf-8"),
    ) as {
      mcp?: { allowed?: string[] };
      mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }>;
    };
    expect(raw.mcp?.allowed).toEqual(["openclaw"]);
    expect(raw.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:23119/mcp");
    expect(raw.mcpServers?.openclaw?.headers?.Authorization).toBe("Bearer lb-tk-123");
    expect(raw.mcpServers?.openclaw?.headers?.["x-openclaw-client-caps"]).toBe(
      "tool-events,inline-widgets",
    );

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
