// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUsageTab } from "./app-render-usage-tab.ts";
import type { AppViewState } from "./app-view-state.ts";
import type { LazyView } from "./lazy-view.ts";
import type { UsageProps } from "./views/usageTypes.ts";

const loadUsageMock = vi.hoisted(() => vi.fn(async () => {}));
const renderUsageMock = vi.hoisted(() => vi.fn((_props: UsageProps) => null));

vi.mock("./controllers/usage.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./controllers/usage.ts")>();
  return {
    ...actual,
    loadUsage: loadUsageMock,
  };
});

type UsageViewModule = typeof import("./views/usage.ts");

function createLoadedUsageView(): LazyView<UsageViewModule> {
  return {
    read: () => ({ renderUsage: renderUsageMock }) as unknown as UsageViewModule,
    retry: () => {},
    error: () => undefined,
    hasError: () => false,
    pending: () => false,
  };
}

function createState(overrides: Partial<AppViewState> = {}): AppViewState {
  return {
    tab: "usage",
    usageLoading: false,
    usageError: null,
    usageResult: null,
    usageCostSummary: null,
    usageStartDate: "2026-02-16",
    usageEndDate: "2026-02-16",
    usageScope: "family",
    usageAgentId: null,
    usageSelectedSessions: [],
    usageSelectedDays: [],
    usageSelectedHours: [],
    usageQuery: "",
    usageQueryDraft: "",
    usageQueryDebounceTimer: null,
    usageTimeZone: "local",
    agentsList: {
      defaultId: "main",
      mainKey: "agent:main:main",
      agents: [{ id: "main" }, { id: "research" }],
    },
    ...overrides,
  } as unknown as AppViewState;
}

describe("renderUsageTab", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes configured agents to the usage view", () => {
    renderUsageTab(createState(), createLoadedUsageView());

    expect(renderUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ agents: ["main", "research"] }),
      }),
    );
  });

  it("reloads usage when selecting an agent scope", () => {
    const state = createState();

    renderUsageTab(state, createLoadedUsageView());
    expect(renderUsageMock).toHaveBeenCalled();
    const props = renderUsageMock.mock.calls[0]?.[0];
    if (!props) {
      throw new Error("expected renderUsage props");
    }
    props.callbacks.filters.onAgentChange("research");

    expect(state.usageAgentId).toBe("research");
    expect(loadUsageMock).toHaveBeenCalledWith(state);
  });
});
