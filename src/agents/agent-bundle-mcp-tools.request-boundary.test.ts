/** Tests configured MCP tools survive policy/splitting to the outbound request boundary. */
import { GetPromptResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { McpServerToolFilterConfig } from "../config/types.mcp.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import {
  createBundleMcpToolRuntime,
  materializeBundleMcpToolsForRun,
} from "./agent-bundle-mcp-materialize.js";
import type {
  McpCatalogTool,
  McpToolCatalog,
  McpToolCatalogDiagnostic,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import {
  applyFinalEffectiveToolPolicy,
  buildBundleMcpPolicyLayers,
  createBundleMcpServerPolicyMatcher,
} from "./embedded-agent-runner/effective-tool-policy.js";
import { applyEmbeddedAttemptToolsAllow } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { splitSdkTools } from "./embedded-agent-runner/tool-split.js";
import { consumeMcpCodeModeGuestResult } from "./mcp-content.js";
import { isMcpToolAllowed } from "./mcp-tool-filter.js";

// Regression coverage for #76063. The reporter's evidence was a captured
// outbound provider request body that contained only built-in OpenClaw tools
// and no `server__*` MCP tool definitions, even though `cfg.mcp.servers`
// declared healthy stdio servers. The materialize/policy/split units each
// have their own focused tests, but ClawSweeper noted that the full request-
// boundary path was uncovered: configured (`cfg.mcp.servers.<name>`) tools
// must materialize, survive `applyFinalEffectiveToolPolicy`, and reach
// `splitSdkTools().customTools` (the value passed to the SDK as
// `customTools`, which is what the provider receives). This test asserts
// that boundary behavior with a fake session MCP runtime so it can run
// against current main without booting a real stdio child.

function makeConfiguredRuntime(
  params: {
    serverName?: string;
    toolNames?: string[];
    /** The server's own `toolFilter`, applied to raw names as the real catalog load does. */
    toolFilter?: McpServerToolFilterConfig;
    /** Session `mcpToolsDeny` raw names, dropped after the filter as the real load does. */
    deniedToolNames?: string[];
  } = {},
): SessionMcpRuntime {
  const serverName = params.serverName ?? "userMcp";
  const toolNames = (params.toolNames ?? ["list_inbox", "send_reply"]).filter(
    (toolName) =>
      isMcpToolAllowed(params.toolFilter, toolName) && !params.deniedToolNames?.includes(toolName),
  );
  const tools: McpCatalogTool[] = toolNames.map((toolName) => ({
    serverName,
    safeServerName: serverName,
    toolName,
    description: `${serverName}.${toolName}`,
    inputSchema: { type: "object", properties: {} },
    fallbackDescription: `${serverName}.${toolName}`,
  }));
  const catalog = {
    version: 1 as const,
    generatedAt: 0,
    servers: {
      [serverName]: {
        serverName,
        launchSummary: serverName,
        toolCount: tools.length,
        ...(params.toolFilter ? { toolFilter: params.toolFilter } : {}),
      },
    },
    tools,
  };
  return {
    sessionId: "session-request-boundary",
    workspaceDir: "/workspace",
    configFingerprint: "fingerprint",
    createdAt: 0,
    lastUsedAt: 0,
    markUsed: () => {},
    getCatalog: async () => catalog,
    peekCatalog: () => catalog,
    callTool: async () => ({
      content: [{ type: "text", text: "FROM-CONFIG" }],
      isError: false,
    }),
    dispose: async () => {},
  };
}

async function buildConfiguredMcpToolNamesAtRequestBoundary(params: {
  cfg: OpenClawConfig;
  serverName?: string;
  toolNames?: string[];
  toolFilter?: McpServerToolFilterConfig;
  deniedToolNames?: string[];
  toolsAllow?: string[];
  reservedToolNames?: string[];
}): Promise<string[]> {
  const runtime = await createBundleMcpToolRuntime({
    workspaceDir: "/workspace",
    cfg: params.cfg,
    reservedToolNames: params.reservedToolNames,
    createRuntime: () => makeConfiguredRuntime(params),
  });
  const filtered = applyFinalEffectiveToolPolicy({
    bundledTools: applyEmbeddedAttemptToolsAllow(runtime.tools, params.toolsAllow, {
      toolMeta: (tool) => getPluginToolMeta(tool),
    }),
    config: params.cfg,
    conversationCapabilityProfile: resolveConversationCapabilityProfile({ config: params.cfg }),
    warn: () => {},
  });
  const { customTools } = splitSdkTools({ tools: filtered, sandboxEnabled: false });
  return customTools.map((tool) => tool.name);
}

describe("configured MCP tools reach the request boundary (#76063)", () => {
  it("includes server__* tools in customTools under the coding profile", async () => {
    const names = await buildConfiguredMcpToolNamesAtRequestBoundary({
      cfg: {
        tools: { profile: "coding" },
        mcp: {
          servers: {
            userMcp: {
              command: "node",
              args: ["user-mcp.mjs"],
            },
          },
        },
      },
    });

    expect(names).toEqual(["userMcp__list_inbox", "userMcp__send_reply"]);
  });

  it("includes server__* tools in customTools under the messaging profile", async () => {
    const names = await buildConfiguredMcpToolNamesAtRequestBoundary({
      cfg: {
        tools: { profile: "messaging" },
        mcp: {
          servers: {
            userMcp: {
              command: "node",
              args: ["user-mcp.mjs"],
            },
          },
        },
      },
    });

    expect(names).toEqual(["userMcp__list_inbox", "userMcp__send_reply"]);
  });

  it("removes configured server__* tools from customTools under the minimal profile", async () => {
    const names = await buildConfiguredMcpToolNamesAtRequestBoundary({
      cfg: {
        tools: { profile: "minimal" },
        mcp: {
          servers: {
            userMcp: {
              command: "node",
              args: ["user-mcp.mjs"],
            },
          },
        },
      },
    });

    expect(names).toEqual([]);
  });

  it("respects an explicit tools.deny: ['bundle-mcp'] entry under the coding profile", async () => {
    const names = await buildConfiguredMcpToolNamesAtRequestBoundary({
      cfg: {
        tools: { profile: "coding", deny: ["bundle-mcp"] },
        mcp: {
          servers: {
            userMcp: {
              command: "node",
              args: ["user-mcp.mjs"],
            },
          },
        },
      },
    });

    expect(names).toEqual([]);
  });

  it("preserves materialize ordering at the request boundary so prompt cache keys stay stable", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeConfiguredRuntime({
        toolNames: ["zeta_tool", "alpha_tool", "mu_tool"],
      }),
    });
    const cfg: OpenClawConfig = { tools: { profile: "coding" } };
    const filtered = applyFinalEffectiveToolPolicy({
      bundledTools: runtime.tools,
      config: cfg,
      conversationCapabilityProfile: resolveConversationCapabilityProfile({ config: cfg }),
      warn: () => {},
    });
    const { customTools } = splitSdkTools({ tools: filtered, sandboxEnabled: false });

    expect(customTools.map((tool) => tool.name)).toEqual([
      "userMcp__alpha_tool",
      "userMcp__mu_tool",
      "userMcp__zeta_tool",
    ]);
  });
  it("exposes MCP resource and prompt utility tools when advertised", async () => {
    const base = makeConfiguredRuntime({ toolNames: [], serverName: "knowledge" });
    const publicResults = {
      prompts_get: {
        description: "Brief the user",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "Summarize MCP",
              annotations: { audience: ["assistant"] },
              _meta: { promptBlock: "preserved" },
            },
          },
        ],
      },
      prompts_list: {
        prompts: [{ name: "brief", _meta: { promptEntry: "preserved" } }],
        nextCursor: "prompt-page-two",
      },
      resources_list: {
        resources: [
          {
            uri: "memo://one",
            name: "memo",
            annotations: { priority: 0.5 },
            _meta: { resourceEntry: "preserved" },
          },
        ],
        nextCursor: "resource-page-two",
      },
      resources_read: {
        contents: [{ uri: "memo://one", text: "memo text", _meta: { content: "preserved" } }],
      },
    };
    const privateResults = Object.fromEntries(
      Object.entries(publicResults).map(([operation, value]) => [
        operation,
        { ...value, _meta: { privateState: `${operation}-must-not-leak` } },
      ]),
    );
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: {
        ...base,
        getCatalog: async () => ({
          version: 1,
          generatedAt: 0,
          servers: {
            knowledge: {
              serverName: "knowledge",
              safeServerName: "knowledge",
              launchSummary: "knowledge",
              toolCount: 0,
              resources: { listChanged: true },
              prompts: { listChanged: true },
            },
          },
          tools: [],
        }),
        listResources: async () => privateResults.resources_list,
        readResource: async () => privateResults.resources_read,
        listPrompts: async () => privateResults.prompts_list,
        getPrompt: async () => GetPromptResultSchema.parse(privateResults.prompts_get),
      },
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual([
      "knowledge__prompts_get",
      "knowledge__prompts_list",
      "knowledge__resources_list",
      "knowledge__resources_read",
    ]);

    for (const [operation, args] of [
      ["prompts_get", { name: "brief" }],
      ["prompts_list", {}],
      ["resources_list", {}],
      ["resources_read", { uri: "memo://one" }],
    ] as const) {
      const tool = expectDefined(
        runtime.tools.find((candidate) => candidate.name === `knowledge__${operation}`),
        `${operation} utility tool`,
      );
      const result = await tool.execute(`call-${operation}`, args, undefined, undefined);
      if (operation === "prompts_get") {
        expect(result.content).toEqual([
          { type: "text", text: "Brief the user" },
          { type: "text", text: "user:" },
          { type: "text", text: "Summarize MCP" },
        ]);
      } else {
        expect(result.content).toEqual([
          { type: "text", text: JSON.stringify(publicResults[operation], null, 2) },
        ]);
      }
      expect(consumeMcpCodeModeGuestResult(result)).toEqual(publicResults[operation]);
      expect(result.details).toMatchObject({
        mcpServer: "knowledge",
        mcpOperation: operation,
        untrustedMcpOutput: true,
      });
      expect(tool.resultContentSource).toBe("network");
      expect(expectDefined(privateResults[operation], `${operation} private source`)._meta).toEqual(
        {
          privateState: `${operation}-must-not-leak`,
        },
      );
    }

    await expect(
      runtime.tools
        .find((tool) => tool.name === "knowledge__prompts_get")!
        .execute("call-prompt", { name: "brief", arguments: { count: 1 } }, undefined, undefined),
    ).rejects.toThrow("arguments.count must be a string");
  });

  it("presents prompt images with their roles while preserving the raw guest template", async () => {
    const image = {
      type: "image",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
      mimeType: "image/png",
    } as const;
    const prompt = GetPromptResultSchema.parse({
      description: "Describe the supplied diagram",
      messages: [
        { role: "user", content: { type: "text", text: "Explain this image." } },
        { role: "user", content: image },
        { role: "assistant", content: { type: "text", text: "An example answer." } },
      ],
    });
    const base = makeConfiguredRuntime({ toolNames: [], serverName: "diagrams" });
    const catalog = await base.getCatalog();
    catalog.servers.diagrams!.prompts = {};
    const materialized = await materializeBundleMcpToolsForRun({
      runtime: { ...base, getCatalog: async () => catalog, getPrompt: async () => prompt },
    });
    const tool = expectDefined(
      materialized.tools.find((candidate) => candidate.name === "diagrams__prompts_get"),
      "prompt utility",
    );
    const result = await tool.execute("prompt-image", { name: "diagram" }, undefined, undefined);

    expect(result.content).toEqual([
      { type: "text", text: "Describe the supplied diagram" },
      { type: "text", text: "user:" },
      { type: "text", text: "Explain this image." },
      { type: "text", text: "user:" },
      image,
      { type: "text", text: "assistant:" },
      { type: "text", text: "An example answer." },
    ]);
    const originalPrompt = structuredClone(prompt);
    prompt.description = "A later server-side edit";
    expect(consumeMcpCodeModeGuestResult(result)).toEqual(originalPrompt);
  });
});

// Regression coverage for #137398. A server whose catalog load failed exposes no
// tool names, so its outage diagnostic is admitted by the server namespace. That
// decision must agree with the one the same policy makes about that server's
// tools: an operator who could still reach a memos tool learns memos is down
// (otherwise the model keeps retrying a generic lookup miss), and one who could
// never reach any memos tool learns nothing about it.
describe("failed MCP server outages follow the same policy as that server's tools (#137398)", () => {
  const outageCases: Array<{
    label: string;
    tools?: OpenClawConfig["tools"];
    toolsAllow?: string[];
    /** The memos server's own `toolFilter`, applied to raw names before any policy layer. */
    toolFilter?: McpServerToolFilterConfig;
    /** Healthy memos tool names for this row (defaults to `read_note`, `write_note`). */
    toolNames?: string[];
    /** Names other tools already hold, so a colliding memos tool materializes renamed. */
    reservedToolNames?: string[];
    /** Session `toolOverrides.mcpToolsDeny` raw names for memos. */
    deniedToolNames?: string[];
    visible: boolean;
  }> = [
    { label: "the coding profile", tools: { profile: "coding" }, visible: true },
    { label: "the minimal profile", tools: { profile: "minimal" }, visible: false },
    {
      label: "tools.deny: ['bundle-mcp']",
      tools: { profile: "coding", deny: ["bundle-mcp"] },
      visible: false,
    },
    {
      label: "an allowlist naming one memos tool",
      tools: { allow: ["memos__read_note"] },
      visible: true,
    },
    {
      label: "an exact deny of one memos tool",
      tools: { profile: "coding", deny: ["memos__read_note"] },
      visible: true,
    },
    {
      label: "a deny glob covering part of the memos namespace",
      tools: { profile: "coding", deny: ["memos__s*"] },
      visible: true,
    },
    {
      label: "a deny glob covering the whole memos namespace",
      tools: { profile: "coding", deny: ["memos__*"] },
      visible: false,
    },
    {
      label: "an allowlist naming another server",
      tools: { allow: ["notes__lookup"] },
      visible: false,
    },
    {
      label: "an allow glob and a deny glob covering the same memos tools",
      tools: { allow: ["memos__read*"], deny: ["memos__read*"] },
      visible: false,
    },
    {
      label: "an allow glob and a deny glob covering different memos tools",
      tools: { allow: ["memos__read*"], deny: ["memos__write*"] },
      visible: true,
    },
    {
      label: "an allow glob wider than the namespace under a deny covering it",
      tools: { allow: ["mem*"], deny: ["memos__*"] },
      visible: false,
    },
    {
      label: "a repeated-wildcard deny covering the whole memos namespace",
      tools: { profile: "coding", deny: ["memos__**"] },
      visible: false,
    },
    {
      label: "a deny glob that would catch a synthetic name but not the memos tools",
      tools: { profile: "coding", deny: ["memos__t*"] },
      visible: true,
    },
    {
      label: "an exact deny of a memos tool name that does not exist",
      tools: { profile: "coding", deny: ["memos__tool"] },
      visible: true,
    },
    {
      label: "a runtime allow glob reaching memos tools",
      toolsAllow: ["memos__read*"],
      visible: true,
    },
    {
      label: "config and runtime allow globs that share a memos tool",
      tools: { allow: ["memos__read*"] },
      toolsAllow: ["memos__*note"],
      visible: true,
    },
    {
      label: "config and runtime allow globs that share no memos tool",
      tools: { allow: ["memos__read*"] },
      toolsAllow: ["memos__write*"],
      visible: false,
    },
    {
      label: "an allow glob no provider-safe memos tool name can match",
      tools: { allow: ["memos__~*"] },
      visible: false,
    },
    {
      label: "a deny entry no provider-safe memos tool name can match",
      tools: { profile: "coding", deny: ["memos__~"] },
      visible: true,
    },
    {
      label: "an allow entry spelled in uppercase with surrounding spaces",
      tools: { allow: [" Memos__READ_note "] },
      visible: true,
    },
    {
      label: "a deny glob spelled in uppercase",
      tools: { profile: "coding", deny: ["MEMOS__*"] },
      visible: false,
    },
    {
      label: "an allow glob whose memos suffix starts with a digit",
      tools: { allow: ["memos__1*"] },
      visible: false,
    },
    {
      label: "an allow entry whose memos suffix starts with a dash",
      tools: { allow: ["memos__-note"] },
      visible: false,
    },
    {
      label: "an allow entry longer than any materialized tool name",
      tools: { allow: [`memos__${"n".repeat(60)}`] },
      visible: false,
    },
    {
      label: "a deny glob whose memos suffix starts with a digit",
      tools: { profile: "coding", deny: ["memos__1*"] },
      visible: true,
    },
    {
      label: "an allow glob whose literal already fills the 64-character name budget",
      tools: { allow: [`memos__${"n".repeat(57)}*`] },
      toolNames: ["n".repeat(57)],
      visible: true,
    },
    {
      label: "an allow glob that needs a letter before a digit-led suffix",
      tools: { allow: ["memos__*1"] },
      toolNames: ["v1"],
      visible: true,
    },
    {
      label: "an allowlist naming a hyphenated memos tool",
      tools: { allow: ["memos__read-note"] },
      toolNames: ["read-note", "write-note"],
      visible: true,
    },
    {
      label: "an exact deny of a hyphenated memos tool beside its sibling",
      tools: { profile: "coding", deny: ["memos__read-note"] },
      toolNames: ["read-note", "write-note"],
      visible: true,
    },
    {
      label: "denies spelling every letter, underscore, and dash under an allow glob",
      tools: {
        allow: ["memos__a*"],
        deny: [
          "memos__a",
          ..."abcdefghijklmnopqrstuvwxyz_-".split("").map((char) => `memos__a${char}*`),
        ],
      },
      toolNames: ["a0"],
      visible: true,
    },
    {
      label: "the same full-length inner literal in a config and a runtime allow glob",
      tools: { allow: [`memos__*${"n".repeat(57)}*`] },
      toolsAllow: [`memos__*${"n".repeat(57)}*`],
      toolNames: ["n".repeat(57)],
      visible: true,
    },
    {
      label: "twenty same-shaped allow globs in two layers with every one denied",
      tools: {
        allow: Array.from(
          { length: 20 },
          (_, index) => `memos__*d${String(index + 1).padStart(2, "0")}*`,
        ),
        deny: Array.from(
          { length: 20 },
          (_, index) => `memos__*d${String(index + 1).padStart(2, "0")}*`,
        ),
      },
      toolsAllow: Array.from(
        { length: 20 },
        (_, index) => `memos__*d${String(index + 1).padStart(2, "0")}*`,
      ),
      toolNames: ["d01x"],
      visible: false,
    },
    {
      label: "sixty-five same-shaped allow globs with the first sixty-four denied",
      tools: {
        allow: Array.from(
          { length: 65 },
          (_, index) => `memos__*t${String(index + 1).padStart(2, "0")}*`,
        ),
        deny: Array.from(
          { length: 64 },
          (_, index) => `memos__*t${String(index + 1).padStart(2, "0")}*`,
        ),
      },
      toolNames: ["at65"],
      visible: true,
    },
    {
      label: "a config allow glob that only the 65th runtime allow glob shares a tool with",
      tools: { allow: ["memos__t65*"] },
      toolsAllow: Array.from(
        { length: 65 },
        (_, index) => `memos__t${String(index + 1).padStart(2, "0")}*`,
      ),
      toolNames: ["t65x"],
      visible: true,
    },
    {
      label: "a long allow literal under denies that each track one suffix letter",
      tools: {
        allow: [`memos__*${"a".repeat(40)}`],
        deny: "bcdfghijklnpqrtuvwxy".split("").map((char) => `memos__*${char}*0`),
      },
      toolNames: ["a".repeat(40)],
      visible: true,
    },
    {
      // Depth-first walks `b` first and reaches the post-`ab` positions through
      // `bab`; only the shorter `ab` leaves room for the 56 trailing `b`s.
      label: "a config allow literal the walk first reaches through a longer name",
      tools: { allow: [`memos__*${"b".repeat(56)}`], deny: ["memos__*b*z"] },
      toolsAllow: ["memos__*ab*"],
      toolNames: [`a${"b".repeat(56)}`],
      visible: true,
    },
    {
      label: "an allow needing a digit every letter denies before it",
      tools: {
        allow: ["memos__*0"],
        deny: "abcdefghijklmnopqrstuvwxyz".split("").map((char) => `memos__*${char}*0`),
      },
      toolNames: ["a0"],
      visible: false,
    },
    {
      label: "an allow and a deny naming the same memos tool",
      tools: { allow: ["memos__read_note"], deny: ["memos__read_note"] },
      visible: false,
    },
    {
      label: "a runtime allowlist that shares no memos tool with the config allowlist",
      tools: { allow: ["memos__read_note"] },
      toolsAllow: ["memos__write_note"],
      visible: false,
    },
    {
      label: "a runtime allowlist naming one memos tool",
      toolsAllow: ["memos__read_note"],
      visible: true,
    },
    {
      label: "a runtime allowlist naming another server",
      toolsAllow: ["notes__lookup"],
      visible: false,
    },
    {
      label: "a server tool filter with an empty include list",
      tools: { profile: "coding" },
      toolFilter: { include: [] },
      visible: true,
    },
    {
      label: "a server tool filter excluding every tool",
      tools: { profile: "coding" },
      toolFilter: { exclude: ["*"] },
      visible: false,
    },
    {
      label: "a server tool filter excluding every tool with a repeated wildcard",
      tools: { profile: "coding" },
      toolFilter: { exclude: ["**"] },
      visible: false,
    },
    {
      label: "a server tool filter excluding every tool with a padded wildcard",
      tools: { profile: "coding" },
      toolFilter: { exclude: [" * "] },
      visible: false,
    },
    {
      label: "a server tool filter excluding tools memos does not have",
      tools: { profile: "coding" },
      toolFilter: { exclude: ["send_*"] },
      visible: true,
    },
    {
      label: "a server tool filter including the read tools",
      tools: { profile: "coding" },
      toolFilter: { include: ["read_*"] },
      visible: true,
    },
    {
      label: "a server tool filter and an allow glob sharing the read tools",
      tools: { allow: ["memos__read*"] },
      toolFilter: { include: ["read_*"] },
      visible: true,
    },
    {
      label: "a server tool filter and an allow glob sharing no memos tool",
      tools: { allow: ["memos__write*"] },
      toolFilter: { include: ["read_*"] },
      visible: false,
    },
    {
      label: "a server tool filter keeping only the memos tool an allowlist drops",
      tools: { allow: ["memos__read_note", "notes__list"] },
      toolFilter: { include: ["write_note"] },
      visible: false,
    },
    {
      label: "a server tool filter excluding the one memos tool an allowlist names",
      tools: { allow: ["memos__read_note"] },
      toolFilter: { exclude: ["read_*"] },
      visible: false,
    },
    {
      label: "a server tool filter whose include and exclude cancel",
      tools: { profile: "coding" },
      toolFilter: { include: ["read_*"], exclude: ["read_*"] },
      visible: false,
    },
    {
      label: "a server tool filter spelled with a space and capitals like the tool it keeps",
      tools: { allow: ["memos__read-note"] },
      toolFilter: { include: ["Read Note"] },
      toolNames: ["Read Note", "write_note"],
      visible: true,
    },
    {
      label: "a server tool filter keeping a tool whose safe name an allowlist misspells",
      tools: { allow: ["memos__read_note"] },
      toolFilter: { include: ["Read Note"] },
      toolNames: ["Read Note", "read_note"],
      visible: false,
    },
    {
      label:
        "a server tool filter excluding, with a space and capitals, the tool an allowlist names",
      tools: { allow: ["memos__read-note"] },
      toolFilter: { exclude: ["Read Note"] },
      toolNames: ["Read Note"],
      visible: false,
    },
    {
      label: "an allowlist naming a memos tool whose name another tool already holds",
      tools: { allow: ["memos__read_note"] },
      reservedToolNames: ["memos__read_note"],
      visible: false,
    },
    {
      label: "an allow glob reaching a memos tool renamed after a name collision",
      tools: { allow: ["memos__read*"] },
      reservedToolNames: ["memos__read_note"],
      visible: true,
    },
    {
      label: "a session denial covering the only tool the server filter admits",
      tools: { profile: "coding" },
      toolFilter: { include: ["read_note"] },
      deniedToolNames: ["read_note"],
      visible: false,
    },
    {
      label: "a session denial of one memos tool",
      tools: { profile: "coding" },
      deniedToolNames: ["read_note"],
      visible: true,
    },
    {
      label: "a session denial of the one memos tool an allowlist names",
      tools: { allow: ["memos__read_note", "notes__list"] },
      deniedToolNames: ["read_note"],
      visible: false,
    },
    {
      label: "every discovery gate at once, the policy naming only the denied tool",
      tools: { allow: ["memos__read_note"] },
      toolFilter: { include: ["read_*", "write_*"] },
      deniedToolNames: ["read_note"],
      reservedToolNames: ["memos__write_note"],
      visible: false,
    },
    {
      label: "every discovery gate at once, the policy reaching the tool that survives them",
      tools: { allow: ["memos__write*"] },
      toolFilter: { include: ["read_*", "write_*"] },
      deniedToolNames: ["read_note"],
      reservedToolNames: ["memos__write_note"],
      visible: true,
    },
  ];

  it.each(outageCases)("names the memos outage under $label: $visible", async (testCase) => {
    const config: OpenClawConfig = {
      ...(testCase.tools ? { tools: testCase.tools } : {}),
      mcp: {
        servers: {
          memos: {
            command: "node",
            args: ["memos.mjs"],
            ...(testCase.toolFilter ? { toolFilter: testCase.toolFilter } : {}),
          },
        },
      },
    };
    const admitsMcpServer = createBundleMcpServerPolicyMatcher(
      buildBundleMcpPolicyLayers({
        conversationCapabilityProfile: resolveConversationCapabilityProfile({ config }),
        toolsAllow: testCase.toolsAllow,
        reservedToolNames: testCase.reservedToolNames,
      }),
    );
    const namesWhenHealthy = await buildConfiguredMcpToolNamesAtRequestBoundary({
      cfg: config,
      serverName: "memos",
      toolNames: testCase.toolNames ?? ["read_note", "write_note"],
      toolFilter: testCase.toolFilter,
      deniedToolNames: testCase.deniedToolNames,
      toolsAllow: testCase.toolsAllow,
      reservedToolNames: testCase.reservedToolNames,
    });

    // The failed server's diagnostic carries the same filter and session denials
    // its healthy catalog load applied, so both sides are judged from one config.
    const diagnostic = {
      safeServerName: "memos",
      toolFilter: testCase.toolFilter,
      deniedToolNames: testCase.deniedToolNames,
    };
    expect(admitsMcpServer(diagnostic)).toBe(testCase.visible);
    expect(namesWhenHealthy.length > 0).toBe(testCase.visible);
  });
});

describe("a server that still materializes a tool stays out of the outage record (#137398)", () => {
  it("keeps a recovering server with retained tools out of the outage record", async () => {
    // A closed transport schedules a catalog retry that keeps the server entry
    // and its tools; only a server without a catalog entry is unavailable.
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        diagnostics: [
          {
            serverName: "bundleProbe",
            safeServerName: "bundleProbe",
            launchSummary: "bundleProbe",
            message: "mcp transport closed",
          },
        ],
      }),
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    expect(runtime.diagnostics).toBeUndefined();
  });

  it("keeps a requester server whose sign-in tool is materialized out of the outage record", async () => {
    // `mergeMcpConnectCatalog` gives an authorized per-requester server whose
    // catalog load failed its `<server>__connect` tool; that recovery action
    // stays callable, so the run must not name the server as absent.
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: {
        ...makeToolRuntime({
          diagnostics: [
            {
              serverName: "memos",
              safeServerName: "memos",
              launchSummary: "memos",
              message: "connect ECONNREFUSED",
            },
          ],
        }),
        requesterConnect: {
          catalog: {
            version: 1,
            generatedAt: 0,
            servers: {
              memos: { serverName: "memos", launchSummary: "Requester OAuth", toolCount: 1 },
            },
            tools: [
              {
                serverName: "memos",
                safeServerName: "memos",
                toolName: "connect",
                description: "Connect your memos account.",
                inputSchema: { type: "object", properties: {} },
                fallbackDescription: "Connect your memos account.",
              },
            ],
          },
          authorizedServerNames: ["memos"],
          configFingerprint: "requester",
          createExecute: () => undefined,
        },
      },
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual([
      "bundleProbe__bundle_probe",
      "memos__connect",
    ]);
    expect(runtime.diagnostics).toBeUndefined();
  });
});

// Local copy of the materialize test fixture; #140312 removed the shared
// `agent-bundle-mcp-tools.test-support` module in favor of per-file fixtures.
function makeToolRuntime(
  params: {
    tools?: McpCatalogTool[];
    serverName?: string;
    diagnostics?: readonly McpToolCatalogDiagnostic[];
  } = {},
): SessionMcpRuntime {
  const serverName = params.serverName ?? "bundleProbe";
  const tools = params.tools ?? [
    {
      serverName,
      safeServerName: serverName,
      toolName: "bundle_probe",
      description: "Bundle probe",
      inputSchema: { type: "object", properties: {} },
      fallbackDescription: "Bundle probe",
    },
  ];
  const peekCatalog = (): McpToolCatalog => ({
    version: 1,
    generatedAt: 0,
    servers: {
      [serverName]: {
        serverName,
        launchSummary: serverName,
        toolCount: tools.length,
        supportsParallelToolCalls: false,
      },
    },
    tools,
    ...(params.diagnostics ? { diagnostics: params.diagnostics } : {}),
  });
  return {
    sessionId: "session-collision",
    workspaceDir: "/tmp",
    configFingerprint: "fingerprint",
    createdAt: 0,
    lastUsedAt: 0,
    markUsed: () => {},
    getCatalog: async () => peekCatalog(),
    peekCatalog,
    callTool: async () => ({
      content: [{ type: "text", text: "FROM-BUNDLE" }],
      isError: false,
    }),
    joinCleanup: async () => {},
    dispose: async () => {},
  };
}
