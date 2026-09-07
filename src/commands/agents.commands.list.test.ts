// Agent command-list tests cover provider metadata and command output for configured agents.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";

const {
  buildProviderStatusIndexMock,
  buildProviderSummaryMetadataIndexMock,
  listProvidersForAgentMock,
  listAgentProvenanceMock,
  readAgentProvenanceMock,
  providerSummaryMetadataMock,
  requireValidConfigMock,
  summarizeBindingsMock,
} = vi.hoisted(() => ({
  buildProviderStatusIndexMock: vi.fn(),
  buildProviderSummaryMetadataIndexMock: vi.fn(),
  listProvidersForAgentMock: vi.fn(),
  listAgentProvenanceMock: vi.fn(),
  readAgentProvenanceMock: vi.fn(),
  providerSummaryMetadataMock: new Map([
    [
      "telegram",
      {
        label: "Telegram",
        defaultAccountId: "default",
        visibleInConfiguredLists: true,
      },
    ],
  ]),
  requireValidConfigMock: vi.fn(),
  summarizeBindingsMock: vi.fn(),
}));

vi.mock("./config-validation.js", () => ({
  requireValidConfig: requireValidConfigMock,
}));

vi.mock("./agents.providers.js", () => ({
  buildProviderStatusIndex: buildProviderStatusIndexMock,
  buildProviderSummaryMetadataIndex: buildProviderSummaryMetadataIndexMock,
  listProvidersForAgent: listProvidersForAgentMock,
  summarizeBindings: summarizeBindingsMock,
}));

vi.mock("../state/agent-provenance.js", () => ({
  listAgentProvenance: listAgentProvenanceMock,
  readAgentProvenance: readAgentProvenanceMock,
}));

const { agentsListCommand } = await import("./agents.commands.list.js");

function createRuntime(): OutputRuntimeEnv & { json: unknown[] } {
  const json: unknown[] = [];
  return {
    json,
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn((value: unknown) => {
      json.push(value);
    }),
  };
}

function createConfig(): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "main", default: true }],
    },
    bindings: [{ agentId: "main", match: { channel: "telegram" } }],
  };
}

describe("agentsListCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireValidConfigMock.mockResolvedValue(createConfig());
    buildProviderStatusIndexMock.mockResolvedValue(new Map());
    buildProviderSummaryMetadataIndexMock.mockReturnValue(providerSummaryMetadataMock);
    listProvidersForAgentMock.mockReturnValue(["Telegram default: configured"]);
    listAgentProvenanceMock.mockReturnValue([]);
    readAgentProvenanceMock.mockReturnValue(undefined);
    summarizeBindingsMock.mockReturnValue(["Telegram default"]);
  });

  it("adds durable provenance to JSON without loading provider details", async () => {
    const runtime = createRuntime();
    readAgentProvenanceMock.mockReturnValue({
      agentId: "main",
      createdVia: "operator",
      creatorAgentId: null,
      createdAtMs: 42,
    });

    await agentsListCommand({ json: true }, runtime);

    expect(buildProviderStatusIndexMock).not.toHaveBeenCalled();
    const summary = (runtime.json[0] as Array<Record<string, unknown>>)[0];
    expect(summary?.id).toBe("main");
    expect(summary).toMatchObject({
      createdVia: "operator",
      creatorAgentId: null,
      createdAt: 42,
    });
    expect(summary).not.toHaveProperty("routes");
    expect(summary).not.toHaveProperty("providers");
  });

  it("renders roots, children, missing rows, and dangling creators as a tree", async () => {
    requireValidConfigMock.mockResolvedValueOnce({
      agents: {
        entries: {
          main: { name: "Main" },
          child: { name: "Child" },
          legacy: { name: "Legacy" },
          orphan: { name: "Orphan" },
        },
      },
    } satisfies OpenClawConfig);
    listAgentProvenanceMock.mockReturnValue([
      { agentId: "main", createdVia: "operator", creatorAgentId: null, createdAtMs: 1 },
      { agentId: "child", createdVia: "agent", creatorAgentId: "main", createdAtMs: 2 },
      { agentId: "orphan", createdVia: "agent", creatorAgentId: "deleted", createdAtMs: 3 },
    ]);
    const runtime = createRuntime();

    await agentsListCommand({ tree: true }, runtime);

    expect(vi.mocked(runtime.log)).toHaveBeenCalledWith(
      [
        "Agents:",
        "- main (Main)",
        "  - child (Child)",
        "- legacy (Legacy)",
        "- orphan (Orphan)",
      ].join("\n"),
    );
    expect(buildProviderStatusIndexMock).not.toHaveBeenCalled();
  });

  it("keeps provider details available for JSON callers that request bindings", async () => {
    const runtime = createRuntime();
    const cfg = createConfig();
    const providerStatus = new Map();
    requireValidConfigMock.mockResolvedValueOnce(cfg);
    buildProviderStatusIndexMock.mockResolvedValueOnce(providerStatus);

    await agentsListCommand({ json: true, bindings: true }, runtime);

    expect(buildProviderStatusIndexMock).toHaveBeenCalledOnce();
    expect(buildProviderSummaryMetadataIndexMock).toHaveBeenCalledOnce();
    expect(summarizeBindingsMock).toHaveBeenCalledWith(
      cfg,
      cfg.bindings,
      providerSummaryMetadataMock,
    );
    expect(listProvidersForAgentMock).toHaveBeenCalledWith({
      summaryIsDefault: true,
      cfg,
      bindings: cfg.bindings,
      providerStatus,
      providerMetadata: providerSummaryMetadataMock,
    });
    const [summary] = runtime.json[0] as Array<Record<string, unknown>>;
    expect(summary?.id).toBe("main");
    expect(summary?.routes).toEqual(["Telegram default"]);
    expect(summary?.providers).toEqual(["Telegram default: configured"]);
    expect(summary).not.toHaveProperty("createdVia");
    expect(summary).not.toHaveProperty("creatorAgentId");
    expect(summary).not.toHaveProperty("createdAt");
  });

  it("keeps human output enriched from read-only provider metadata", async () => {
    const runtime = createRuntime();

    await agentsListCommand({}, runtime);

    expect(buildProviderStatusIndexMock).toHaveBeenCalledOnce();
    expect(buildProviderSummaryMetadataIndexMock).toHaveBeenCalledOnce();
    expect(vi.mocked(runtime.log).mock.calls).toEqual([
      [
        [
          "Agents:",
          "- main (default)",
          `  Workspace: ~${path.sep}.openclaw${path.sep}workspace`,
          `  Agent dir: ~${path.sep}.openclaw${path.sep}agents${path.sep}main${path.sep}agent`,
          "  Routing rules: 1",
          "  Routing: Telegram default",
          "  Providers:",
          "    - Telegram default: configured",
          "Routing rules map channel/account/peer to an agent. Use --bindings for full rules.",
          "Channel status reflects local config/creds. For live health: openclaw channels status --probe.",
        ].join("\n"),
      ],
    ]);
  });

  it.each([
    {
      label: "configured",
      identity: {
        name: " Chosen Identity ",
        emoji: "🦉",
        avatar: "https://example.invalid/new.png",
      },
      expected: {
        identityName: "Chosen Identity",
        identityEmoji: "🦉",
        identityAvatarUrl: "https://example.invalid/new.png",
        identitySource: "config",
      },
    },
    {
      label: "partially configured",
      identity: { name: "Chosen Identity" },
      expected: {
        identityName: "Chosen Identity",
        identityEmoji: "🦞",
        identityAvatarUrl: "https://example.invalid/workspace.png",
        identitySource: "config",
      },
    },
    ...[
      { label: "workspace-only", identity: undefined },
      { label: "blank configured", identity: { name: " ", emoji: "\t", avatar: " " } },
      { label: "unsupported configured avatar", identity: { avatar: "slack://avatar.png" } },
    ].map(({ label, identity }) => ({
      label,
      identity,
      expected: {
        identityName: "Workspace Identity",
        identityEmoji: "🦞",
        identityAvatarUrl: "https://example.invalid/workspace.png",
        identitySource: "identity",
      },
    })),
  ])("lists $label identity values with workspace fallback", async ({ identity, expected }) => {
    await withTestDir({ prefix: "openclaw-agent-identity-list-" }, async (workspace) => {
      const identityPath = path.join(workspace, "IDENTITY.md");
      const identityFile =
        "# Identity\n\n- Name: Workspace Identity\n- Emoji: 🦞\n- Avatar: https://example.invalid/workspace.png\n";
      fs.writeFileSync(identityPath, identityFile);
      requireValidConfigMock.mockResolvedValue({
        agents: { entries: { proof: { workspace, identity } } },
      } satisfies OpenClawConfig);
      const jsonRuntime = createRuntime();
      await agentsListCommand({ json: true }, jsonRuntime);
      expect(jsonRuntime.json[0]).toEqual([expect.objectContaining(expected)]);

      const textRuntime = createRuntime();
      await agentsListCommand({}, textRuntime);
      const source = expected.identitySource === "config" ? "config" : "IDENTITY.md";
      expect(vi.mocked(textRuntime.log).mock.calls.flat().join("\n")).toContain(
        `Identity: ${expected.identityEmoji} ${expected.identityName} (${source})`,
      );
      expect(fs.readFileSync(identityPath, "utf8")).toBe(identityFile);
    });
  });

  it("sanitizes configured agent text without changing JSON summaries", async () => {
    const control = "\u001B]0;agents-list-injection\u0007";
    const identityName = `${control}Operator 🦞\r\nforged-row`;
    const workspace = `/tmp/workspace-${control}\tpath`;
    const model = `${control}provider/model\nvariant`;
    const cfg = {
      agents: {
        entries: {
          main: {
            name: `${control}Main\nAlias`,
            workspace,
            agentDir: `/tmp/agent-${control}\npath`,
            model,
            identity: { name: identityName },
          },
        },
      },
      bindings: [{ agentId: "main", match: { channel: "telegram" } }],
    } satisfies OpenClawConfig;
    requireValidConfigMock.mockResolvedValue(cfg);
    summarizeBindingsMock.mockReturnValue([`${control}Telegram\nroute`]);
    listProvidersForAgentMock.mockReturnValue([`${control}Telegram\tconfigured`]);

    const textRuntime = createRuntime();
    await agentsListCommand({ bindings: true }, textRuntime);

    const textOutput = vi.mocked(textRuntime.log).mock.calls.flat().join("\n");
    expect(textOutput).not.toContain("\u001B");
    expect(textOutput).not.toContain("\nforged-row");
    expect(textOutput).toContain("Operator 🦞\\r\\nforged-row");
    expect(textOutput).toContain("provider/model\\nvariant");
    expect(textOutput).toContain("Telegram\\nroute");

    const jsonRuntime = createRuntime();
    await agentsListCommand({ json: true }, jsonRuntime);

    // Workspace paths are platform-normalized before JSON, so assert the
    // non-sanitization invariant on it rather than byte equality.
    expect(jsonRuntime.json[0]).toEqual([expect.objectContaining({ identityName, model })]);
    expect((jsonRuntime.json[0] as Array<{ workspace: string }>)[0]?.workspace).toContain(control);
  });

  it.skipIf(process.platform !== "win32")(
    "shortens real Windows home casing aliases in human output",
    async () => {
      await withTestDir({ prefix: "openclaw-home-display-" }, async (home) => {
        const workspace = path.join(home, "workspace");
        const agentDir = path.join(home, "agents", "main", "agent");
        await fs.promises.mkdir(workspace, { recursive: true });
        await fs.promises.mkdir(agentDir, { recursive: true });
        const homeAlias = home.toUpperCase();
        expect(fs.statSync(homeAlias).isDirectory()).toBe(true);

        requireValidConfigMock.mockResolvedValueOnce({
          agents: {
            list: [
              {
                id: "main",
                default: true,
                workspace: path.join(homeAlias, "workspace"),
                agentDir: path.join(homeAlias, "agents", "main", "agent"),
              },
            ],
          },
        } satisfies OpenClawConfig);
        const runtime = createRuntime();

        await withEnvAsync({ OPENCLAW_HOME: home }, async () => {
          await agentsListCommand({}, runtime);
        });

        const output = vi.mocked(runtime.log).mock.calls.flat().join("\n");
        expect(output).toContain(`Workspace: $OPENCLAW_HOME${path.sep}workspace`);
        expect(output).toContain(
          `Agent dir: $OPENCLAW_HOME${path.sep}agents${path.sep}main${path.sep}agent`,
        );
        expect(output).not.toContain(homeAlias);
      });
    },
  );
});
