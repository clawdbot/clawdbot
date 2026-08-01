/** Behavior tests for server-granular MCP allowlist selection. */
import { afterEach, describe, expect, it } from "vitest";
import { selectAllowlistedStaticMcpServerNames } from "./mcp-allowlist-server-select.js";

describe("selectAllowlistedStaticMcpServerNames", () => {
  afterEach(async () => {
    const { testing } = await import("./mcp-connection-resolver.js");
    testing.setMcpServerConnectionResolversForTest();
  });

  const cfg = {
    mcp: { servers: { opik: { command: "true" }, notion: { command: "true" } } },
  };

  const select = (toolsAllow: string[] | undefined) =>
    selectAllowlistedStaticMcpServerNames({
      cfg: cfg as never,
      workspaceDir: "/workspace",
      toolsAllow,
    });

  it.each([
    { toolsAllow: ["*"], expected: ["notion", "opik"] },
    { toolsAllow: ["bundle-mcp"], expected: ["notion", "opik"] },
    { toolsAllow: ["group:plugins"], expected: ["notion", "opik"] },
    { toolsAllow: ["opik__*"], expected: ["opik"] },
    { toolsAllow: ["opik__list"], expected: ["opik"] },
    // Normalization: surrounding space and server-prefix case are ignored.
    { toolsAllow: [" Opik__list "], expected: ["opik"] },
    { toolsAllow: ["message"], expected: [] },
    // A bare `<server>__` with no tool fragment does not reference the server.
    { toolsAllow: ["opik__"], expected: [] },
    // An empty allowlist restricts to nothing.
    { toolsAllow: [], expected: [] },
  ])("selects $expected for allowlist $toolsAllow", ({ toolsAllow, expected }) => {
    expect([...select(toolsAllow)].toSorted()).toEqual(expected);
  });

  it("selects every static server referenced by a multi-token allowlist", () => {
    // A merged allow + alsoAllow list is just more tokens: each server the list
    // names is selected. Deny is not a server-selection input — a denied tool on
    // an allowed server still opens the server; the tool is dropped downstream by
    // the harness tool policy, not here.
    expect([...select(["opik__read", "notion__list"])].toSorted()).toEqual(["notion", "opik"]);
  });

  it("returns an empty set when the allowlist imposes no restriction", () => {
    expect(select(undefined).size).toBe(0);
  });

  it("excludes a server this agent may not reach", () => {
    // `codex.agents` is the same capability boundary the native projection
    // applies; the dynamic bridge must not become a way around it.
    const scopedCfg = {
      mcp: {
        servers: {
          opik: { command: "true", codex: { agents: ["agent-a"] } },
          notion: { command: "true" },
        },
      },
    };
    const selectFor = (agentId?: string) =>
      selectAllowlistedStaticMcpServerNames({
        cfg: scopedCfg as never,
        workspaceDir: "/workspace",
        toolsAllow: ["opik__read", "notion__read"],
        ...(agentId ? { agentId } : {}),
      });

    expect([...selectFor("agent-a")].toSorted()).toEqual(["notion", "opik"]);
    expect([...selectFor("agent-b")].toSorted()).toEqual(["notion"]);
    // No agent id at all is fail-closed for a server that declares `agents`.
    expect([...selectFor()].toSorted()).toEqual(["notion"]);
  });

  it("excludes a server the session disabled", () => {
    const selected = selectAllowlistedStaticMcpServerNames({
      cfg: cfg as never,
      workspaceDir: "/workspace",
      toolsAllow: ["opik__read", "notion__read"],
      toolOverrides: { mcpServers: { opik: false } },
    });
    expect([...selected].toSorted()).toEqual(["notion"]);
  });

  it("excludes a user server whose name a plugin also declares", () => {
    // The bundle-MCP patch still attaches that name natively on this turn, so
    // exposing it here too would surface one server through two attachments.
    const selected = selectAllowlistedStaticMcpServerNames({
      cfg: {
        mcp: { servers: { opik: { command: "true" }, notion: { command: "true" } } },
        plugins: { entries: { "curated-mcp": { enabled: true } } },
      } as never,
      workspaceDir: "/workspace-collision",
      manifestRegistry: {
        plugins: [
          {
            id: "curated-mcp",
            origin: "global",
            format: "openclaw",
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            rootDir: "/plugins/curated-mcp",
            source: "/plugins/curated-mcp/index.js",
            manifestPath: "/plugins/curated-mcp/openclaw.plugin.json",
            mcpServers: {
              opik: { transport: "streamable-http", url: "https://curated.example.test/mcp" },
            },
          },
        ],
      } as never,
      toolsAllow: ["opik__read", "notion__list"],
    });
    expect([...selected].toSorted()).toEqual(["notion"]);
  });

  it("excludes a plugin-curated server the user did not configure", () => {
    // Only the user-MCP patch is omitted on a scoped turn; the bundle-MCP patch
    // still attaches plugin servers natively, so selecting them here would
    // surface the same server twice.
    const selected = selectAllowlistedStaticMcpServerNames({
      cfg: {
        mcp: { servers: { opik: { command: "true" } } },
        plugins: { entries: { "curated-mcp": { enabled: true } } },
      } as never,
      workspaceDir: "/workspace-plugin-curated",
      manifestRegistry: {
        plugins: [
          {
            id: "curated-mcp",
            origin: "global",
            format: "openclaw",
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            rootDir: "/plugins/curated-mcp",
            source: "/plugins/curated-mcp/index.js",
            manifestPath: "/plugins/curated-mcp/openclaw.plugin.json",
            mcpServers: {
              curated: { transport: "streamable-http", url: "https://curated.example.test/mcp" },
            },
          },
        ],
      } as never,
      toolsAllow: ["opik__read", "curated__read"],
    });
    expect([...selected].toSorted()).toEqual(["opik"]);
  });

  it("excludes a requester-scoped server even when the allowlist names it", async () => {
    const { testing } = await import("./mcp-connection-resolver.js");
    // A registered resolver makes opik requester-scoped; it must not be selected
    // as a static server (it resolves on its own path, not the static harness).
    testing.setMcpServerConnectionResolversForTest([
      { serverName: "opik", resolve: async () => ({ url: "https://mcp.example.test" }) },
    ]);
    const selected = select(["opik__read", "notion__read"]);
    expect(selected.has("opik")).toBe(false);
    expect(selected.has("notion")).toBe(true);
  });
});
