// Agent command-list tests cover provider metadata and command output for configured agents.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";

const {
  buildProviderStatusIndexMock,
  buildProviderSummaryMetadataIndexMock,
  listProvidersForAgentMock,
  providerSummaryMetadataMock,
  requireValidConfigMock,
  summarizeBindingsMock,
} = vi.hoisted(() => ({
  buildProviderStatusIndexMock: vi.fn(),
  buildProviderSummaryMetadataIndexMock: vi.fn(),
  listProvidersForAgentMock: vi.fn(),
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
    summarizeBindingsMock.mockReturnValue(["Telegram default"]);
  });

  it("keeps plain JSON output on the config-only path", async () => {
    const runtime = createRuntime();

    await agentsListCommand({ json: true }, runtime);

    expect(buildProviderStatusIndexMock).not.toHaveBeenCalled();
    const summary = (runtime.json[0] as Array<Record<string, unknown>>)[0];
    expect(summary?.id).toBe("main");
    expect(summary).not.toHaveProperty("routes");
    expect(summary).not.toHaveProperty("providers");
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

  it.skipIf(process.platform !== "win32")(
    "shortens real Windows home casing aliases in human output",
    async () => {
      await withTempDir({ prefix: "openclaw-home-display-" }, async (home) => {
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
