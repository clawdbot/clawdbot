import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import type { McpToolCatalog, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { createAgentHarnessPromptToolPolicy } from "./harness/prompt-tool-policy.js";
import { MAX_TOOL_SEARCH_BATCH_RESPONSE_CHARS } from "./tool-search-types.js";
import {
  applyToolSearchCatalog,
  createToolSearchCatalogRef,
  createToolSearchTools,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "./tool-search.js";
import type { AnyAgentTool } from "./tools/common.js";

// Operator-facing launch detail must never reach model text; only the server
// name and the redacted failure message may.
const LAUNCH_SUMMARY = "launch-summary-secret";
const FAILURE_MESSAGE = "connect ECONNREFUSED 127.0.0.1:5230";

function makeRuntime(catalog: McpToolCatalog): SessionMcpRuntime {
  return {
    sessionId: "session-tool-search-mcp-unavailable",
    workspaceDir: "/tmp",
    configFingerprint: "fingerprint",
    createdAt: 0,
    lastUsedAt: 0,
    markUsed: () => {},
    getCatalog: async () => catalog,
    peekCatalog: () => catalog,
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    dispose: async () => {},
  };
}

/** One healthy server ("notes") plus one whose catalog load failed ("memos"). */
function makeOutageCatalog(): McpToolCatalog {
  return {
    version: 1,
    generatedAt: 0,
    servers: {
      notes: {
        serverName: "notes",
        launchSummary: "notes",
        toolCount: 1,
        supportsParallelToolCalls: false,
      },
    },
    tools: [
      {
        serverName: "notes",
        safeServerName: "notes",
        toolName: "list",
        description: "List saved notes",
        inputSchema: { type: "object", properties: {} },
        fallbackDescription: "List saved notes",
      },
    ],
    diagnostics: [
      {
        serverName: "memos",
        safeServerName: "memos",
        launchSummary: LAUNCH_SUMMARY,
        message: FAILURE_MESSAGE,
      },
    ],
  };
}

/**
 * The outage payload at its caps: eight failed servers, safe names at the
 * 30-character sanitized prefix limit, redacted errors made of JSON-escaped
 * control characters (six serialized characters each).
 */
function makeEscapedOutagesCatalog(): McpToolCatalog {
  const catalog = makeOutageCatalog();
  catalog.diagnostics = Array.from({ length: 8 }, (_, index) => ({
    serverName: `down${index}`,
    safeServerName: `down${index}`.padEnd(30, "d"),
    launchSummary: LAUNCH_SUMMARY,
    message: "\u0001".repeat(200),
  }));
  return catalog;
}

async function createControls(catalog: McpToolCatalog, mode: "tools" | "code" = "tools") {
  const materialized = await materializeBundleMcpToolsForRun({ runtime: makeRuntime(catalog) });
  const config = { tools: { toolSearch: { enabled: true, mode } } };
  const catalogRef = createToolSearchCatalogRef();
  const controls = createToolSearchTools({ config, catalogRef });
  const tools = [...controls, ...materialized.tools];
  applyToolSearchCatalog({ tools, config, catalogRef, mcpDiagnostics: materialized.diagnostics });
  const control = (name: string): AnyAgentTool =>
    expectDefined(
      controls.find((tool) => tool.name === name),
      `${name} control`,
    );
  return { control, materialized, catalogRef, tools };
}

describe("Tool Search with an unavailable MCP server", () => {
  it("names the failed server in tool_search results instead of returning a bare miss", async () => {
    const { control } = await createControls(makeOutageCatalog());
    const search = control(TOOL_SEARCH_RAW_TOOL_NAME);

    const miss = await search.execute("search-miss", { query: "memos" });
    expect(miss.details).toEqual({
      candidates: [],
      unavailableMcpServers: [{ server: "memos", error: FAILURE_MESSAGE }],
      note: expect.stringContaining("memos"),
    });

    const hit = await search.execute("search-hit", { query: "list saved notes" });
    expect(hit.details).toMatchObject({
      candidates: [expect.objectContaining({ id: "mcp:notes:notes__list" })],
      unavailableMcpServers: [{ server: "memos", error: FAILURE_MESSAGE }],
    });

    const batch = await search.execute("search-batch", {
      queries: [{ query: "memos" }, { query: "list saved notes" }],
    });
    expect(batch.details).toMatchObject({
      results: [
        { query: "memos", candidates: [] },
        {
          query: "list saved notes",
          candidates: [expect.objectContaining({ name: "notes__list" })],
        },
      ],
      unavailableMcpServers: [{ server: "memos", error: FAILURE_MESSAGE }],
    });

    for (const result of [miss, hit, batch]) {
      expect(JSON.stringify(result)).not.toContain(LAUNCH_SUMMARY);
    }
  });

  it("reports the outage for a catalog-id lookup on the failed server", async () => {
    const { control } = await createControls(makeOutageCatalog());
    const id = "mcp:memos:memos__read_note";

    for (const name of [TOOL_CALL_RAW_TOOL_NAME, TOOL_DESCRIBE_RAW_TOOL_NAME]) {
      const error = await control(name)
        .execute(`lookup-${name}`, { id, args: {} })
        .then(
          () => undefined,
          (caught: unknown) => caught as Error,
        );
      expect(error?.message).toContain('MCP server "memos"');
      expect(error?.message).toContain(FAILURE_MESSAGE);
      expect(error?.message).not.toContain("Unknown tool id");
      expect(error?.message).not.toContain(LAUNCH_SUMMARY);
    }
  });

  it.each([
    { label: "a server without a recorded failure", id: "mcp:other:other__read" },
    { label: "a bare name that only matches the failed server", id: "memos" },
    {
      label: "a name-shaped id with no catalog entry proving MCP ownership",
      id: "memos__read_note",
    },
  ])("keeps the generic unknown-tool recovery for $label", async ({ id }) => {
    const { control } = await createControls(makeOutageCatalog());

    await expect(
      control(TOOL_CALL_RAW_TOOL_NAME).execute("lookup-generic", { id, args: {} }),
    ).rejects.toThrow(`Unknown tool id: ${id}`);
  });

  it("keeps plain results when no MCP server failed", async () => {
    const healthy = makeOutageCatalog();
    delete healthy.diagnostics;
    const { control, materialized } = await createControls(healthy);
    expect(materialized.diagnostics).toBeUndefined();

    const miss = await control(TOOL_SEARCH_RAW_TOOL_NAME).execute("search-miss", {
      query: "memos",
    });
    expect(miss.details).toEqual([]);
    await expect(
      control(TOOL_CALL_RAW_TOOL_NAME).execute("lookup-missing", {
        id: "mcp:memos:memos__read_note",
        args: {},
      }),
    ).rejects.toThrow("Unknown tool id: mcp:memos:memos__read_note");
  });

  it("hides the outage behind a prompt-hook tool cap that cannot admit the failed server", async () => {
    const { control, catalogRef, tools } = await createControls(makeOutageCatalog());
    const search = control(TOOL_SEARCH_RAW_TOOL_NAME);
    const policy = createAgentHarnessPromptToolPolicy({
      tools,
      catalogRef,
      codeModeControlsEnabled: false,
    });
    const outage = { unavailableMcpServers: [{ server: "memos", error: FAILURE_MESSAGE }] };

    // Capped to another server's tool, no allow entry can reach "memos".
    policy.apply({ toolsAllow: ["notes__list"] });
    expect(catalogRef.current?.mcpDiagnostics).toBeUndefined();
    expect((await search.execute("search-capped", { query: "memos" })).details).toEqual([]);

    // Plugin-group and unrestricted hooks admit the namespace and restore the note.
    policy.apply({ toolsAllow: ["group:plugins"] });
    expect((await search.execute("search-group", { query: "memos" })).details).toMatchObject(
      outage,
    );
    policy.apply();
    expect((await search.execute("search-open", { query: "memos" })).details).toMatchObject(outage);
  });

  it("keeps the outage payload inside the batch response cap at every limit", async () => {
    const { control } = await createControls(makeEscapedOutagesCatalog());
    // Sixteen queries filling the 512-byte batch text budget, none matching:
    // nothing but the echoed queries and the outage payload remains to render.
    const batch = await control(TOOL_SEARCH_RAW_TOOL_NAME).execute("search-batch-escaped", {
      queries: Array.from({ length: 16 }, (_, index) => ({
        query: `${index}`.padEnd(28, "q"),
        limit: 1,
      })),
    });
    const details = batch.details as {
      results: Array<{ candidates: unknown[] }>;
      unavailableMcpServers: Array<{ error: string }>;
    };
    expect(details.results.every((result) => result.candidates.length === 0)).toBe(true);
    expect(details.unavailableMcpServers).toHaveLength(8);
    for (const server of details.unavailableMcpServers) {
      expect(JSON.stringify(server.error).length - 2).toBeLessThanOrEqual(160);
    }
    expect(JSON.stringify(details, null, 2).length).toBeLessThanOrEqual(
      MAX_TOOL_SEARCH_BATCH_RESPONSE_CHARS,
    );
  });

  it("carries the outage on a code mode exec whose only action is a search", async () => {
    const { control } = await createControls(makeOutageCatalog(), "code");

    const result = await control(TOOL_SEARCH_CODE_MODE_TOOL_NAME).execute("code-mode-search", {
      code: `return await openclaw.tools.search("memos");`,
    });

    // The in-guest search stays a plain array for user code; the exec result
    // itself names the failed server so the first search already stops a loop.
    expect(result.details).toMatchObject({
      ok: true,
      value: [],
      unavailableMcpServers: [{ server: "memos", error: FAILURE_MESSAGE }],
      note: expect.stringContaining("memos"),
    });
    expect(JSON.stringify(result)).not.toContain(LAUNCH_SUMMARY);
  });

  it("surfaces the outage to code mode calls", async () => {
    const { control } = await createControls(makeOutageCatalog(), "code");

    const result = await control(TOOL_SEARCH_CODE_MODE_TOOL_NAME).execute("code-mode-outage", {
      code: `
        try {
          await openclaw.tools.call("mcp:memos:memos__read_note", {});
          return "no error";
        } catch (error) {
          return String(error?.message ?? error);
        }
      `,
    });

    expect(result.details).toMatchObject({
      ok: true,
      value: expect.stringContaining('MCP server "memos"'),
    });
    expect(JSON.stringify(result)).not.toContain(LAUNCH_SUMMARY);
  });
});
