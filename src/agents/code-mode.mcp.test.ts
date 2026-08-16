/** Tests Code Mode MCP namespace. */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  resetCodeModeTestState,
  mcpTool,
  createCodeModeHarness,
  runUntilCompleted,
} from "./code-mode.test-support.js";

describe("Code Mode MCP namespace", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCodeModeTestState();
  });

  it("exposes MCP tools only through the MCP namespace", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const githubCreate = mcpTool({
      name: "github__create_issue",
      serverName: "github",
      toolName: "create_issue",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string", description: "Repository 名称" },
          title: { type: "string", description: "Issue title\nShown in tracker" },
          body: { type: "string", default: "" },
        },
        required: ["owner", "repo", "title"],
      },
    });
    const compacted = applyCodeModeCatalog({
      tools: [...codeModeTools, githubCreate],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    expect(compacted.tools[0]?.description).toContain("MCP: MCP server tools grouped by server.");
    expect(compacted.tools[0]?.description).toContain("visible servers: github");

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        const rootApi = await MCP.$api();
        const api = await MCP.github.$api("createIssue", { schema: true });
        const apiFiles = await API.list("mcp");
        const apiFilesTrailingSlash = await API.list("mcp/");
        const rootFile = await API.read("mcp/index.d.ts");
        const serverFile = await API.read("mcp/github.d.ts");
        const created = await MCP.github.createIssue({
          owner: "openclaw",
          repo: "openclaw",
          title: "Ship it",
        });
        const createdPayload = JSON.parse(created.content[0].text);
        const searchHits = await tools.search("github create issue", { limit: 5 });
        const allHasMcp = ALL_TOOLS.some((tool) => tool.source === "mcp");
        let directCall;
        let directDescribe;
        try {
          await tools.describe("github__create_issue");
          directDescribe = "unexpected";
        } catch (error) {
          directDescribe = error.message;
        }
        try {
          await tools.call("github__create_issue", { owner: "x", repo: "y", title: "blocked" });
          directCall = "unexpected";
        } catch (error) {
          directCall = error.message;
        }
        return {
          apiHeader: api.header,
          apiFilePaths: apiFiles.files.map((file) => file.path),
          apiFilePathsTrailingSlash: apiFilesTrailingSlash.files.map((file) => file.path),
          listedServerFileBytes: apiFiles.files.find((file) => file.path === "mcp/github.d.ts").bytes,
          serverFileBytes: serverFile.bytes,
          serverFileContent: serverFile.content,
          rootFileHasReference: rootFile.content.includes('./github.d.ts'),
          serverFileHasCreateIssue: serverFile.content.includes('function createIssue('),
          serverFileHasTitleDoc: serverFile.content.includes('@param title Issue title Shown in tracker'),
          apiSchemaTitle: api.schemas.createIssue.type,
          rootServers: rootApi.servers,
          createdPayload,
          createdDetails: created.details,
          searchHits,
          allHasMcp,
          directDescribe,
          directCall,
          hasMcp: "MCP" in namespaces,
        };
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({
      createdPayload: {
        serverName: "github",
        toolName: "create_issue",
        input: {
          owner: "openclaw",
          repo: "openclaw",
          title: "Ship it",
          body: "",
        },
      },
      createdDetails: {
        serverName: "github",
        toolName: "create_issue",
        input: {
          owner: "openclaw",
          repo: "openclaw",
          title: "Ship it",
          body: "",
        },
      },
      searchHits: [],
      allHasMcp: false,
      directDescribe:
        "Unknown tool id: github__create_issue. Use tools.search to find a tool, tools.describe to inspect it, then tools.call with the exact id or name.",
      directCall:
        "Unknown tool id: github__create_issue. Use tools.search to find a tool, tools.describe to inspect it, then tools.call with the exact id or name.",
      hasMcp: true,
      apiSchemaTitle: "object",
      apiHeader: expect.stringContaining("function createIssue("),
      apiFilePaths: ["mcp/index.d.ts", "mcp/github.d.ts"],
      apiFilePathsTrailingSlash: ["mcp/index.d.ts", "mcp/github.d.ts"],
      listedServerFileBytes: expect.any(Number),
      serverFileBytes: expect.any(Number),
      serverFileContent: expect.stringContaining("Repository 名称"),
      rootFileHasReference: true,
      serverFileHasCreateIssue: true,
      serverFileHasTitleDoc: true,
      rootServers: [{ identifier: "github", serverName: "github", toolCount: 1 }],
    });
    const value = details.value as {
      apiHeader: string;
      listedServerFileBytes: number;
      serverFileBytes: number;
      serverFileContent: string;
    };
    expect(value.listedServerFileBytes).toBe(value.serverFileBytes);
    expect(value.serverFileBytes).toBe(Buffer.byteLength(value.serverFileContent, "utf8"));
    expect(value.serverFileBytes).toBeGreaterThan(value.serverFileContent.length);
    expect(value.apiHeader).toContain("@param title Issue title Shown in tracker");
    expect(value.apiHeader).not.toContain("@param title Issue title\n");
    expect(value.apiHeader).toContain("title: string;");
    expect(githubCreate.execute).toHaveBeenCalledTimes(1);
  });

  it("lets agents inspect MCP declaration files before calling MCP tools", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const githubCreate = mcpTool({
      name: "github__create_issue",
      serverName: "github",
      toolName: "create_issue",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          title: { type: "string", description: "Issue title" },
        },
        required: ["owner", "repo", "title"],
      },
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, githubCreate],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        const files = await API.list("mcp");
        const api = await API.read("mcp/github.d.ts");
        const created = await MCP.github.createIssue({
          owner: "openclaw",
          repo: "openclaw",
          title: "From file docs",
        });
        return {
          fileCount: files.files.length,
          headerHasSignature: api.content.includes("function createIssue("),
          usedApiCall: api.content.includes("function $api("),
          created: JSON.parse(created.content[0].text),
        };
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({
      fileCount: 2,
      headerHasSignature: true,
      usedApiCall: true,
      created: {
        serverName: "github",
        toolName: "create_issue",
        input: {
          owner: "openclaw",
          repo: "openclaw",
          title: "From file docs",
        },
      },
    });
    expect(githubCreate.execute).toHaveBeenCalledTimes(1);
  });

  it("groups MCP resources and prompts under server namespaces", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const resourceRead = mcpTool({
      name: "docs__resources_read",
      serverName: "docs",
      toolName: "resources_read",
      operation: "resources_read",
      parameters: {
        type: "object",
        properties: { uri: { type: "string" } },
        required: ["uri"],
      },
    });
    const promptGet = mcpTool({
      name: "docs__prompts_get",
      serverName: "docs",
      toolName: "prompts_get",
      operation: "prompts_get",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          arguments: { type: "object" },
        },
        required: ["name"],
      },
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, resourceRead, promptGet],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        const api = await MCP.docs.$api();
        const resource = await MCP.docs.resources.read({ uri: "memo://one" });
        const prompt = await MCP.docs.prompts.get({ name: "brief", arguments: { topic: "mcp" } });
        return { header: api.header, resource: resource.details, prompt: prompt.details };
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({
      resource: {
        serverName: "docs",
        toolName: "resources_read",
        input: { uri: "memo://one" },
      },
      prompt: {
        serverName: "docs",
        toolName: "prompts_get",
        input: { name: "brief", arguments: { topic: "mcp" } },
      },
      header: expect.stringContaining("namespace resources"),
    });
  });

  it("renames MCP namespace identifiers that would be unsafe path segments", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const dangerous = mcpTool({
      name: "constructor__prototype",
      serverName: "constructor",
      toolName: "prototype",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, dangerous],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: 'return (await MCP.constructor2.prototype2({ value: "safe" })).details;',
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({
      serverName: "constructor",
      toolName: "prototype",
      input: { value: "safe" },
    });
  });

  describe("reserved MCP tool names", () => {
    const toolNames = ["delete", "default", "return", "enum", "class"] as const;
    const targets = new Map<string, ReturnType<typeof mcpTool>>();
    let results: Record<string, unknown>;

    beforeAll(async () => {
      const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
      for (const toolName of toolNames) {
        targets.set(
          toolName,
          mcpTool({
            name: `github__${toolName}`,
            serverName: "github",
            toolName,
            parameters: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          }),
        );
      }
      applyCodeModeCatalog({
        tools: [...codeModeTools, ...targets.values()],
        config,
        sessionId: "session-code-mode",
        sessionKey: "agent:main:main",
        runId: "run-code-mode",
        catalogRef,
      });

      const details = await runUntilCompleted({
        execTool: expectDefined(codeModeTools[0], "Code Mode exec test invariant"),
        waitTool: expectDefined(codeModeTools[1], "Code Mode wait test invariant"),
        code: `
          const file = await API.read("mcp/github.d.ts");
          const results = {};
          for (const toolName of ${JSON.stringify(toolNames)}) {
            const safeName = toolName + "2";
            const api = await MCP.github.$api(safeName);
            const result = await MCP.github[safeName]({ value: "safe" });
            results[toolName] = { file: file.content, header: api.header, result: result.details };
          }
          return results;
        `,
      });

      expect(details.status).toBe("completed");
      results = details.value as Record<string, unknown>;
    });

    it.each(toolNames)("renders and executes reserved MCP tool name %s safely", (toolName) => {
      const safeName = `${toolName}2`;
      expect(results[toolName]).toEqual({
        file: expect.stringContaining(`function ${safeName}(`),
        header: expect.stringContaining(`function ${safeName}(`),
        result: {
          serverName: "github",
          toolName,
          input: { value: "safe" },
        },
      });
      expect(targets.get(toolName)?.execute).toHaveBeenCalledTimes(1);
    });
  });
});
