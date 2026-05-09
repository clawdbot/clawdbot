import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import {
  listConfiguredMcpServers,
  setConfiguredMcpServer,
  unsetConfiguredMcpServer,
} from "./mcp-config.js";

function validationOk(raw: unknown) {
  return { ok: true as const, config: raw, warnings: [] };
}

const mockReadSourceConfigSnapshot = vi.hoisted(() => async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const configPath = path.join(process.env.OPENCLAW_STATE_DIR ?? "", "openclaw.json");
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      valid: true,
      path: configPath,
      sourceConfig: parsed,
      resolved: parsed,
      hash: "test-hash",
    };
  } catch {
    return {
      valid: false,
      path: configPath,
    };
  }
});

const mockReplaceConfigFile = vi.hoisted(() => async ({ nextConfig }: { nextConfig: unknown }) => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const configPath = path.join(process.env.OPENCLAW_STATE_DIR ?? "", "openclaw.json");
  await fs.writeFile(configPath, JSON.stringify(nextConfig, null, 2), "utf-8");
});

vi.mock("./io.js", () => ({
  readSourceConfigSnapshot: mockReadSourceConfigSnapshot,
}));

vi.mock("./mutate.js", () => ({
  replaceConfigFile: mockReplaceConfigFile,
}));

vi.mock("./validation.js", () => ({
  validateConfigObjectWithPlugins: validationOk,
  validateConfigObjectRawWithPlugins: validationOk,
}));

async function withMcpConfigHome<T>(
  config: unknown,
  fn: (params: { configPath: string }) => Promise<T>,
) {
  return await withTempHome(
    async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
      return await fn({ configPath });
    },
    {
      prefix: "openclaw-mcp-config-",
      skipSessionCleanup: true,
      env: {
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
    },
  );
}

describe("config mcp config", () => {
  it("writes and removes top-level mcp servers", async () => {
    await withMcpConfigHome({}, async () => {
      const setResult = await setConfiguredMcpServer({
        name: "context7",
        server: {
          command: "uvx",
          args: ["context7-mcp"],
        },
      });

      expect(setResult.ok).toBe(true);
      const loaded = await listConfiguredMcpServers();
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) {
        throw new Error("expected MCP config to load");
      }
      expect(loaded.mcpServers.context7).toEqual({
        command: "uvx",
        args: ["context7-mcp"],
      });

      const unsetResult = await unsetConfiguredMcpServer({ name: "context7" });
      expect(unsetResult.ok).toBe(true);

      const reloaded = await listConfiguredMcpServers();
      expect(reloaded.ok).toBe(true);
      if (!reloaded.ok) {
        throw new Error("expected MCP config to reload");
      }
      expect(reloaded.mcpServers).toStrictEqual({});
    });
  });

  it("fails closed when the config file is invalid", async () => {
    await withMcpConfigHome({}, async ({ configPath }) => {
      await fs.writeFile(configPath, "{", "utf-8");

      const loaded = await listConfiguredMcpServers();
      expect(loaded.ok).toBe(false);
      if (loaded.ok) {
        throw new Error("expected invalid config to fail");
      }
      expect(loaded.path).toBe(configPath);
    });
  });

  it("accepts SSE MCP configs with headers at the config layer", async () => {
    await withMcpConfigHome({}, async () => {
      const setResult = await setConfiguredMcpServer({
        name: "remote",
        server: {
          url: "https://example.com/mcp",
          headers: {
            Authorization: "Bearer token123",
            "X-Retry": 1,
            "X-Debug": true,
          },
        },
      });

      expect(setResult.ok).toBe(true);
      const loaded = await listConfiguredMcpServers();
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) {
        throw new Error("expected MCP config to load");
      }
      expect(loaded.mcpServers.remote).toEqual({
        url: "https://example.com/mcp",
        headers: {
          Authorization: "Bearer token123",
          "X-Retry": 1,
          "X-Debug": true,
        },
      });
    });
  });

  it("canonicalizes CLI-native HTTP type aliases when saving MCP config", async () => {
    await withMcpConfigHome({}, async () => {
      const setResult = await setConfiguredMcpServer({
        name: "remote",
        server: {
          type: "http",
          url: "https://example.com/mcp",
        },
      });

      expect(setResult.ok).toBe(true);
      const loaded = await listConfiguredMcpServers();
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) {
        throw new Error("expected MCP config to load");
      }
      expect(loaded.mcpServers.remote).toEqual({
        url: "https://example.com/mcp",
        transport: "streamable-http",
      });
    });
  });
});
