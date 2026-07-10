// Tests MCP command configuration, listing, and enablement behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withTempHome } from "../../config/home-env.test-harness.js";
import { REDACTED_SENTINEL } from "../../config/redact-snapshot.js";
import { createCommandWorkspaceHarness } from "./commands-filesystem.test-support.js";
import { handleMcpCommand } from "./commands-mcp.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const mcpServers = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock("../../config/mcp-config.js", () => ({
  listConfiguredMcpServers: vi.fn(async () => ({
    ok: true,
    path: "/tmp/openclaw.json",
    config: {},
    mcpServers: Object.fromEntries(mcpServers),
  })),
  setConfiguredMcpServer: vi.fn(async ({ name, server }) => {
    mcpServers.set(name, { ...(server as Record<string, unknown>) });
    return {
      ok: true,
      path: "/tmp/openclaw.json",
      config: {},
      mcpServers: Object.fromEntries(mcpServers),
    };
  }),
  unsetConfiguredMcpServer: vi.fn(async ({ name }) => {
    const removed = mcpServers.delete(name);
    return {
      ok: true,
      path: "/tmp/openclaw.json",
      config: {},
      mcpServers: Object.fromEntries(mcpServers),
      removed,
    };
  }),
}));

const workspaceHarness = createCommandWorkspaceHarness("openclaw-command-mcp-");

function expectMcpResult<T>(result: T | null): T {
  if (result === null) {
    throw new Error("expected MCP command result");
  }
  return result;
}

function buildCfg(): OpenClawConfig {
  return {
    commands: {
      text: true,
      mcp: true,
    },
  };
}

describe("handleCommands /mcp", () => {
  afterEach(async () => {
    mcpServers.clear();
    await workspaceHarness.cleanupWorkspaces();
  });

  it("writes MCP config and shows it back", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const setParams = buildCommandTestParams(
        '/mcp set context7={"command":"uvx","args":["context7-mcp"]}',
        buildCfg(),
        undefined,
        { workspaceDir },
      );
      setParams.command.senderIsOwner = true;

      const setResult = expectMcpResult(await handleMcpCommand(setParams, true));
      expect(setResult.reply?.text).toContain('MCP server "context7" saved');

      const showParams = buildCommandTestParams("/mcp show context7", buildCfg(), undefined, {
        workspaceDir,
      });
      showParams.command.senderIsOwner = true;
      const showResult = expectMcpResult(await handleMcpCommand(showParams, true));
      expect(showResult.reply?.text).toContain('"command": "uvx"');
      expect(showResult.reply?.text).toContain('"args": [');
    });
  });

  it("blocks authorized non-owner senders from writing MCP config", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      mcpServers.set("existing", { command: "uvx", args: ["existing-mcp"] });
      const setParams = buildCommandTestParams(
        '/mcp set evil={"command":"/bin/sh","args":["-c","id > /tmp/pwned"]}',
        buildCfg(),
        undefined,
        { workspaceDir },
      );
      setParams.command.senderIsOwner = false;

      const setResult = expectMcpResult(await handleMcpCommand(setParams, true));
      expect(setResult).toEqual({ shouldContinue: false });
      expect(mcpServers.has("evil")).toBe(false);

      const unsetParams = buildCommandTestParams("/mcp unset existing", buildCfg(), undefined, {
        workspaceDir,
      });
      unsetParams.command.senderIsOwner = false;
      const unsetResult = expectMcpResult(await handleMcpCommand(unsetParams, true));
      expect(unsetResult).toEqual({ shouldContinue: false });
      expect(mcpServers.has("existing")).toBe(true);
    });
  });

  it("blocks authorized non-owner senders from reading MCP config", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      mcpServers.set("context7", { command: "uvx", args: ["context7-mcp"] });
      const showParams = buildCommandTestParams("/mcp show context7", buildCfg(), undefined, {
        workspaceDir,
      });
      showParams.command.senderIsOwner = false;

      const showResult = expectMcpResult(await handleMcpCommand(showParams, true));
      expect(showResult).toEqual({ shouldContinue: false });
      const replyText = showResult.reply?.text ?? "";
      expect(replyText).not.toContain('MCP server "context7"');
      expect(replyText).not.toContain('"command": "uvx"');
    });
  });

  it("rejects internal writes without operator.admin", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const params = buildCommandTestParams(
        '/mcp set context7={"command":"uvx","args":["context7-mcp"]}',
        buildCfg(),
        {
          Provider: "webchat",
          Surface: "webchat",
          GatewayClientScopes: ["operator.write"],
        },
        { workspaceDir },
      );
      params.command.senderIsOwner = true;

      const result = expectMcpResult(await handleMcpCommand(params, true));
      expect(result.reply?.text).toContain("requires operator.admin");
    });
  });

  it("accepts non-stdio MCP config at the config layer", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const params = buildCommandTestParams(
        '/mcp set remote={"url":"https://example.com/mcp"}',
        buildCfg(),
        undefined,
        { workspaceDir },
      );
      params.command.senderIsOwner = true;

      const result = expectMcpResult(await handleMcpCommand(params, true));
      expect(result.reply?.text).toContain('MCP server "remote" saved');
    });
  });

  it("redacts credential-bearing headers and env from /mcp show in groups", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const headerSecret = "Bearer sk-test-secret-value";
      const envSecret = "stdio-process-token-value";
      mcpServers.set("billing-server", {
        command: "uvx",
        args: ["billing-mcp"],
        transport: "streamable-http",
        url: "https://billing.example.com/mcp",
        headers: {
          Authorization: headerSecret,
        },
        env: {
          BILLING_TOKEN: envSecret,
        },
      });
      mcpServers.set("local-tools", {
        command: "uvx",
        args: ["local-mcp"],
        env: {
          TOOL_API_KEY: "local-env-secret-value",
        },
      });

      const namedParams = buildCommandTestParams(
        "/mcp show billing-server",
        buildCfg(),
        undefined,
        {
          workspaceDir,
        },
      );
      namedParams.command.senderIsOwner = true;
      namedParams.isGroup = true;
      const namedResult = expectMcpResult(await handleMcpCommand(namedParams, true));
      const namedText = namedResult.reply?.text ?? "";
      expect(namedText).toContain('MCP server "billing-server"');
      expect(namedText).toContain('"command": "uvx"');
      expect(namedText).toContain(REDACTED_SENTINEL);
      expect(namedText).not.toContain(headerSecret);
      expect(namedText).not.toContain(envSecret);
      expect(namedText).not.toContain("sk-test-secret-value");

      const allParams = buildCommandTestParams("/mcp show", buildCfg(), undefined, {
        workspaceDir,
      });
      allParams.command.senderIsOwner = true;
      allParams.isGroup = true;
      const allResult = expectMcpResult(await handleMcpCommand(allParams, true));
      const allText = allResult.reply?.text ?? "";
      expect(allText).toContain('"billing-server"');
      expect(allText).toContain('"local-tools"');
      expect(allText).toContain(REDACTED_SENTINEL);
      expect(allText).not.toContain(headerSecret);
      expect(allText).not.toContain(envSecret);
      expect(allText).not.toContain("local-env-secret-value");
    });
  });
});
