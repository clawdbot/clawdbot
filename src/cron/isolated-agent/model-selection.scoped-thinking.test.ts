// Cron turns must hydrate runtime-only model thinking through the provider-scoped helper,
// never through a full live catalog build.
import { beforeEach, describe, expect, it, vi } from "vitest";

const scopedThinkingCatalogMock = vi.fn(
  async (..._args: unknown[]): Promise<Array<Record<string, unknown>>> => [],
);

vi.mock("./run-model-selection.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./run-model-selection.runtime.js")>();
  return {
    ...actual,
    loadProviderScopedThinkingCatalog: (...args: unknown[]) => scopedThinkingCatalogMock(...args),
  };
});

const owner = {
  agentId: "main",
  agentDir: "/tmp/cron-agent",
  workspaceDir: "/tmp/cron-workspace",
  config: {},
  modelCatalog: { entries: [], routeVariants: [] },
} as never;

describe("resolveCronThinkingSelection scoped hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopedThinkingCatalogMock.mockResolvedValue([]);
  });

  it("hydrates a runtime-only model through the provider-scoped helper", async () => {
    scopedThinkingCatalogMock.mockResolvedValue([
      { provider: "ollama", id: "minimax-m3:cloud", reasoning: true },
    ]);
    const { resolveCronThinkingSelection } = await import("./model-selection.js");
    const selection = await resolveCronThinkingSelection({
      cfg: {},
      owner,
      provider: "ollama",
      model: "minimax-m3:cloud",
      jobThinking: "medium",
    });
    expect(selection.requestedThinkLevel).toBe("medium");
    expect(selection.catalog).toEqual([
      expect.objectContaining({ provider: "ollama", id: "minimax-m3:cloud", reasoning: true }),
    ]);
    expect(scopedThinkingCatalogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "ollama",
        model: "minimax-m3:cloud",
        agentId: "main",
        agentDir: "/tmp/cron-agent",
        workspaceDir: "/tmp/cron-workspace",
      }),
    );
  });

  it("keeps the owner catalog and skips hydration when thinking is off", async () => {
    const { resolveCronThinkingSelection } = await import("./model-selection.js");
    const selection = await resolveCronThinkingSelection({
      cfg: {},
      owner,
      provider: "ollama",
      model: "minimax-m3:cloud",
      jobThinking: "off",
    });
    expect(selection.requestedThinkLevel).toBe("off");
    expect(scopedThinkingCatalogMock).not.toHaveBeenCalled();
  });
});
