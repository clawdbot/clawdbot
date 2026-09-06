// Tests MCP command configuration, listing, and enablement behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withTempHome } from "../../config/home-env.test-harness.js";
import { REDACTED_SENTINEL } from "../../config/redact-snapshot.js";
import { OutboundDeliveryError } from "../../infra/outbound/deliver-types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createCommandWorkspaceHarness } from "./commands-filesystem.test-support.js";
import { handleMcpCommand } from "./commands-mcp.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const mcpServers = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const privateRouteMocks = vi.hoisted(() => ({
  resolvePrivateCommandRouteTargets:
    vi.fn<typeof import("./commands-private-route.js").resolvePrivateCommandRouteTargets>(),
}));
const deliverOutboundPayloads = vi.hoisted(() =>
  vi.fn<typeof import("../../infra/outbound/deliver.js").deliverOutboundPayloadsInternal>(),
);

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: deliverOutboundPayloads,
}));
vi.mock("../../infra/outbound/deliver-runtime.js", () => ({
  deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: deliverOutboundPayloads,
}));

vi.mock("../../config/mcp-config.js", () => ({
  listConfiguredMcpServers: vi.fn(async () => ({
    ok: true,
    path: "/tmp/openclaw.json",
    config: {},
    mcpServers: Object.fromEntries(mcpServers),
  })),
}));

vi.mock("../../agents/mcp-config-mutation.js", () => ({
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

vi.mock("./commands-private-route.js", async () => {
  const actual = await vi.importActual<typeof import("./commands-private-route.js")>(
    "./commands-private-route.js",
  );
  return {
    ...actual,
    resolvePrivateCommandRouteTargets: privateRouteMocks.resolvePrivateCommandRouteTargets,
  };
});

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

async function showGroupMcpConfig() {
  privateRouteMocks.resolvePrivateCommandRouteTargets.mockResolvedValue([
    { channel: "telegram", to: "owner-1" },
    { channel: "signal", to: "owner-2" },
  ]);
  mcpServers.set("billing-server", { command: "uvx", args: ["private-billing-mcp"] });
  const params = buildCommandTestParams("/mcp show", buildCfg());
  params.command.senderIsOwner = true;
  params.isGroup = true;
  return expectMcpResult(await handleMcpCommand(params, true));
}

describe("handleCommands /mcp", () => {
  afterEach(async () => {
    mcpServers.clear();
    privateRouteMocks.resolvePrivateCommandRouteTargets.mockReset();
    deliverOutboundPayloads.mockReset();
    resetPluginRuntimeStateForTest();
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
      expect(setResult).toEqual({
        shouldContinue: false,
        reply: { text: expect.stringContaining("commands.ownerAllowFrom") },
      });
      expect(mcpServers.has("evil")).toBe(false);

      const unsetParams = buildCommandTestParams("/mcp unset existing", buildCfg(), undefined, {
        workspaceDir,
      });
      unsetParams.command.senderIsOwner = false;
      const unsetResult = expectMcpResult(await handleMcpCommand(unsetParams, true));
      expect(unsetResult).toEqual({
        shouldContinue: false,
        reply: { text: expect.stringContaining("commands.ownerAllowFrom") },
      });
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
      expect(showResult).toEqual({
        shouldContinue: false,
        reply: { text: expect.stringContaining("commands.ownerAllowFrom") },
      });
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
      privateRouteMocks.resolvePrivateCommandRouteTargets.mockResolvedValue([
        { channel: "telegram", to: "owner-1" },
      ]);
      deliverOutboundPayloads.mockImplementation(async ({ payloads }) => {
        privateReplies.push(payloads[0]?.text ?? "");
        return [{ channel: "telegram", messageId: "private-config" }];
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
      const namedResult = expectMcpResult(await handleMcpCommand(namedParams, true));
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
      const allResult = expectMcpResult(await handleMcpCommand(allParams, true));
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
    },
    {
      name: "private delivery failure",
      resolvePrivateMcpTargets: async () => [{ channel: "telegram", to: "owner-1" }],
    },
  ])("fails closed for group /mcp show with $name", async (route) => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const secret = "group-route-secret-value";
      mcpServers.set("billing-server", {
        command: "uvx",
        args: ["billing-mcp", "--api-key", secret],
      });
      privateRouteMocks.resolvePrivateCommandRouteTargets.mockImplementation(
        route.resolvePrivateMcpTargets,
      );
      deliverOutboundPayloads.mockRejectedValue(new Error("private route unavailable"));
      const params = buildCommandTestParams("/mcp show billing-server", buildCfg(), undefined, {
        workspaceDir,
      });
      params.command.senderIsOwner = true;
      params.isGroup = true;

      const result = expectMcpResult(await handleMcpCommand(params, true));
      const groupText = result.reply?.text ?? "";
      expect(groupText).toContain("Run /mcp show from an owner DM");
      expect(groupText).not.toContain("billing-server");
      expect(groupText).not.toContain("/tmp/openclaw.json");
      expect(groupText).not.toContain(secret);
    });
  });

  it.each([
    { name: "released", custody: "released" },
    { name: "unowned", custody: undefined },
  ] as const)("tries later private routes after a $name failure", async ({ custody }) => {
    const error = new OutboundDeliveryError("private route unavailable", { cause: undefined });
    error.queueCustody = custody;
    deliverOutboundPayloads
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce([{ channel: "signal", messageId: "fallback-send" }]);
    const result = await showGroupMcpConfig();

    expect(deliverOutboundPayloads.mock.calls.map(([request]) => request.to)).toEqual([
      "owner-1",
      "owner-2",
    ]);
    expect(result.reply?.text).toContain("sent the details to the owner privately");
    expect(result.reply?.text).not.toContain("billing-server");
    expect(result.reply?.text).not.toContain("private-billing-mcp");
  });

  it("keeps identityless first acceptance pending without sending to another private target", async () => {
    deliverOutboundPayloads
      .mockImplementationOnce(async ({ onPayloadDeliveryOutcome }) => {
        onPayloadDeliveryOutcome?.({
          index: 0,
          status: "suppressed",
          reason: "adapter_returned_no_identity",
        });
        return [];
      })
      .mockResolvedValueOnce([{ channel: "signal", messageId: "second-send" }]);
    const result = await showGroupMcpConfig();

    expect(deliverOutboundPayloads.mock.calls.map(([request]) => request.to)).toEqual(["owner-1"]);
    expect(result.reply?.text).toContain("pending");
    expect(result.reply?.text).not.toContain("sent the details");
    expect(result.reply?.text).not.toContain("billing-server");
    expect(result.reply?.text).not.toContain("/tmp/openclaw.json");
  });

  it("tries another private route when channel preparation throws before dispatch", async () => {
    const transformReplyPayload = vi.fn(() => {
      throw new Error("channel preparation failed");
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
            messaging: { transformReplyPayload },
          },
        },
        {
          pluginId: "signal",
          source: "test",
          plugin: createChannelTestPluginBase({ id: "signal", label: "Signal" }),
        },
      ]),
    );
    deliverOutboundPayloads.mockResolvedValueOnce([
      { channel: "signal", messageId: "fallback-send" },
    ]);

    const result = await showGroupMcpConfig();

    expect(transformReplyPayload).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloads.mock.calls.map(([request]) => request.to)).toEqual(["owner-2"]);
    expect(result.reply?.text).toContain("sent the details to the owner privately");
    expect(result.reply?.text).not.toContain("billing-server");
  });

  it.each([
    { name: "held custody", custody: "held", ambiguous: false, visible: false },
    { name: "held partial delivery", custody: "held", ambiguous: false, visible: true },
    { name: "released ambiguity", custody: "released", ambiguous: true, visible: false },
  ] as const)(
    "keeps $name pending without sending to another private target",
    async ({ custody, ambiguous, visible }) => {
      const error = new OutboundDeliveryError("private delivery interrupted", {
        cause: undefined,
        results: visible ? [{ channel: "telegram", messageId: "first-chunk" }] : [],
        payloadOutcomes: [
          {
            index: 0,
            status: "failed",
            error: new Error("interrupted"),
            sentBeforeError: ambiguous,
            stage: "platform_send",
          },
        ],
      });
      error.queueCustody = custody;
      deliverOutboundPayloads.mockRejectedValueOnce(error);
      const result = await showGroupMcpConfig();

      expect(deliverOutboundPayloads.mock.calls.map(([request]) => request.to)).toEqual([
        "owner-1",
      ]);
      expect(result.reply?.text).toContain("pending");
      expect(result.reply?.text).not.toContain("sent the details");
      expect(result.reply?.text).not.toContain("billing-server");
    },
  );

  it.each([
    {
      name: "confirmed delivery",
      suppressed: false,
      acknowledgement: "sent the details to the owner privately",
    },
    {
      name: "intentional suppression",
      suppressed: true,
      acknowledgement: "Private delivery was suppressed; no details were sent",
    },
  ])(
    "stops after $name with an honest acknowledgement",
    async ({ suppressed, acknowledgement }) => {
      deliverOutboundPayloads.mockImplementationOnce(async ({ onPayloadDeliveryOutcome }) => {
        if (suppressed) {
          onPayloadDeliveryOutcome?.({
            index: 0,
            status: "suppressed",
            reason: "cancelled_by_reply_payload_sending_hook",
          });
          return [];
        }
        return [{ channel: "telegram", messageId: "confirmed-send" }];
      });
      const result = await showGroupMcpConfig();

      expect(deliverOutboundPayloads.mock.calls.map(([request]) => request.to)).toEqual([
        "owner-1",
      ]);
      expect(result.reply?.text).toContain(acknowledgement);
      expect(result.reply?.text).not.toContain("billing-server");
    },
  );
});
