import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OutputRuntimeEnv } from "../runtime.js";

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

vi.mock("./agents.command-shared.js", () => ({
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
          "  Workspace: ~/.openclaw/workspace",
          "  Agent dir: ~/.openclaw/agents/main/agent",
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
});
