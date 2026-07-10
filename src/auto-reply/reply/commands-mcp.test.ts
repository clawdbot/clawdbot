// Tests MCP command configuration, listing, and enablement behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withTempHome } from "../../config/home-env.test-harness.js";
import { REDACTED_SENTINEL } from "../../config/redact-snapshot.js";
import { createCommandWorkspaceHarness } from "./commands-filesystem.test-support.js";
import { createMcpCommandHandler, handleMcpCommand } from "./commands-mcp.js";
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

  it("routes group /mcp show privately and redacts the delivered config", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const privateReplies: string[] = [];
      const groupHandler = createMcpCommandHandler({
        resolvePrivateMcpTargets: async () => [{ channel: "telegram", to: "owner-1" }],
        deliverPrivateMcpReply: async ({ reply }) => {
          privateReplies.push(reply.text ?? "");
          return true;
        },
      });
      const headerSecret = "Bearer sk-test-secret-value";
      const envSecret = "stdio-process-token-value";
      const separateArgSecret = "plain-separate-arg-secret";
      const inlineArgSecret = "plain-inline-arg-secret";
      const positionalArgSecret = "ghp_realgithubtoken1234567890ABCD";
      const secretKeyArg = "opaque-secret-key-value";
      const awsSecretAccessKeyArg = "opaque-aws-secret-access-key-value";
      const underscoreApiKeyArg = "opaque-underscore-api-key-value";
      const pluralCredentialsArg = "opaque-plural-credentials-value";
      mcpServers.set("billing-server", {
        command: "uvx",
        args: [
          "billing-mcp",
          "--api-key",
          separateArgSecret,
          `--token=${inlineArgSecret}`,
          positionalArgSecret,
          "--secret-key",
          secretKeyArg,
          `--aws-secret-access-key=${awsSecretAccessKeyArg}`,
          "--openai_api_key",
          underscoreApiKeyArg,
          "--credentials",
          pluralCredentialsArg,
          "--region",
          "us-east-1",
        ],
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
      const namedResult = expectMcpResult(await groupHandler(namedParams, true));
      const namedGroupText = namedResult.reply?.text ?? "";
      expect(namedGroupText).toContain("sent the details to the owner privately");
      expect(namedGroupText).not.toContain("billing-server");
      expect(namedGroupText).not.toContain("/tmp/openclaw.json");
      expect(namedGroupText).not.toContain(headerSecret);
      expect(privateReplies).toHaveLength(1);
      const namedText = privateReplies[0] ?? "";
      expect(namedText).toContain('MCP server "billing-server"');
      expect(namedText).toContain('"command": "uvx"');
      expect(namedText).toContain('"billing-mcp"');
      expect(namedText).toContain('"--api-key"');
      expect(namedText).toContain(`"--token=${REDACTED_SENTINEL}"`);
      expect(namedText).toContain('"--secret-key"');
      expect(namedText).toContain(`"--aws-secret-access-key=${REDACTED_SENTINEL}"`);
      expect(namedText).toContain('"--openai_api_key"');
      expect(namedText).toContain('"--region"');
      expect(namedText).toContain('"us-east-1"');
      expect(namedText).toContain(REDACTED_SENTINEL);
      expect(namedText).not.toContain(headerSecret);
      expect(namedText).not.toContain(envSecret);
      expect(namedText).not.toContain(separateArgSecret);
      expect(namedText).not.toContain(inlineArgSecret);
      expect(namedText).not.toContain(positionalArgSecret);
      expect(namedText).not.toContain(secretKeyArg);
      expect(namedText).not.toContain(awsSecretAccessKeyArg);
      expect(namedText).not.toContain(underscoreApiKeyArg);
      expect(namedText).not.toContain(pluralCredentialsArg);
      expect(namedText).not.toContain("sk-test-secret-value");

      const allParams = buildCommandTestParams("/mcp show", buildCfg(), undefined, {
        workspaceDir,
      });
      allParams.command.senderIsOwner = true;
      allParams.isGroup = true;
      const allResult = expectMcpResult(await groupHandler(allParams, true));
      const allGroupText = allResult.reply?.text ?? "";
      expect(allGroupText).toContain("sent the details to the owner privately");
      expect(allGroupText).not.toContain("billing-server");
      expect(allGroupText).not.toContain("/tmp/openclaw.json");
      expect(privateReplies).toHaveLength(2);
      const allText = privateReplies[1] ?? "";
      expect(allText).toContain('"billing-server"');
      expect(allText).toContain('"local-tools"');
      expect(allText).toContain(REDACTED_SENTINEL);
      expect(allText).not.toContain(headerSecret);
      expect(allText).not.toContain(envSecret);
      expect(allText).not.toContain(separateArgSecret);
      expect(allText).not.toContain(inlineArgSecret);
      expect(allText).not.toContain(positionalArgSecret);
      expect(allText).not.toContain(secretKeyArg);
      expect(allText).not.toContain(awsSecretAccessKeyArg);
      expect(allText).not.toContain(underscoreApiKeyArg);
      expect(allText).not.toContain(pluralCredentialsArg);
      expect(allText).not.toContain("local-env-secret-value");
    });
  });

  it.each([
    {
      name: "no private owner target",
      resolvePrivateMcpTargets: async () => [],
      deliverPrivateMcpReply: async () => true,
    },
    {
      name: "private delivery failure",
      resolvePrivateMcpTargets: async () => [{ channel: "telegram", to: "owner-1" }],
      deliverPrivateMcpReply: async () => false,
    },
  ])("fails closed for group /mcp show with $name", async (route) => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const secret = "group-route-secret-value";
      mcpServers.set("billing-server", {
        command: "uvx",
        args: ["billing-mcp", "--api-key", secret],
      });
      const handler = createMcpCommandHandler(route);
      const params = buildCommandTestParams("/mcp show billing-server", buildCfg(), undefined, {
        workspaceDir,
      });
      params.command.senderIsOwner = true;
      params.isGroup = true;

      const result = expectMcpResult(await handler(params, true));
      const groupText = result.reply?.text ?? "";
      expect(groupText).toContain("Run /mcp show from an owner DM");
      expect(groupText).not.toContain("billing-server");
      expect(groupText).not.toContain("/tmp/openclaw.json");
      expect(groupText).not.toContain(secret);
    });
  });

  it("tries later private owner routes without exposing config to the group", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const attemptedTargets: string[] = [];
      mcpServers.set("billing-server", {
        command: "uvx",
        args: ["billing-mcp", "--api-key", "private-route-secret"],
      });
      const handler = createMcpCommandHandler({
        resolvePrivateMcpTargets: async () => [
          { channel: "telegram", to: "stale-owner-route" },
          { channel: "signal", to: "working-owner-route" },
        ],
        deliverPrivateMcpReply: async ({ targets }) => {
          const target = targets[0]?.to ?? "";
          attemptedTargets.push(target);
          return target === "working-owner-route";
        },
      });
      const params = buildCommandTestParams("/mcp show billing-server", buildCfg(), undefined, {
        workspaceDir,
      });
      params.command.senderIsOwner = true;
      params.isGroup = true;

      const result = expectMcpResult(await handler(params, true));
      const groupText = result.reply?.text ?? "";
      expect(attemptedTargets).toEqual(["stale-owner-route", "working-owner-route"]);
      expect(groupText).toContain("sent the details to the owner privately");
      expect(groupText).not.toContain("billing-server");
      expect(groupText).not.toContain("private-route-secret");
    });
  });
});
