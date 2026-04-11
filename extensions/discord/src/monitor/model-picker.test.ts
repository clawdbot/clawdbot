import { serializePayload } from "@buape/carbon";
import { ComponentType } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  DISCORD_CUSTOM_ID_MAX_CHARS,
  DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE,
  DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE,
  DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX,
  buildDiscordModelPickerCustomId,
  getDiscordModelPickerModelPage,
  getDiscordModelPickerProviderPage,
  loadDiscordModelPickerData,
  parseDiscordModelPickerCustomId,
  parseDiscordModelPickerData,
  renderDiscordModelPickerModelsView,
  renderDiscordModelPickerProvidersView,
  renderDiscordModelPickerRecentsView,
  toDiscordModelPickerMessagePayload,
} from "./model-picker.js";
import { createModelsProviderData } from "./model-picker.test-utils.js";

const buildModelsProviderDataMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/models-provider-runtime", () => ({
  buildModelsProviderData: buildModelsProviderDataMock,
}));

type SerializedComponent = {
  type: number;
  custom_id?: string;
  options?: Array<{ value: string; default?: boolean }>;
  components?: SerializedComponent[];
};

const DISCORD_CONTAINER_COMPONENT_TYPE: SerializedComponent["type"] = ComponentType.Container;
const DISCORD_ACTION_ROW_COMPONENT_TYPE: SerializedComponent["type"] = ComponentType.ActionRow;
const DISCORD_STRING_SELECT_COMPONENT_TYPE: SerializedComponent["type"] =
  ComponentType.StringSelect;

function extractContainerRows(components?: SerializedComponent[]): SerializedComponent[] {
  const container = components?.find(
    (component) => component.type === DISCORD_CONTAINER_COMPONENT_TYPE,
  );
  if (!container) {
    return [];
  }
  return (container.components ?? []).filter(
    (component) => component.type === DISCORD_ACTION_ROW_COMPONENT_TYPE,
  );
}

function renderModelsViewRows(
  params: Parameters<typeof renderDiscordModelPickerModelsView>[0],
): SerializedComponent[] {
  const rendered = renderDiscordModelPickerModelsView(params);
  const payload = serializePayload(toDiscordModelPickerMessagePayload(rendered)) as {
    components?: SerializedComponent[];
  };
  return extractContainerRows(payload.components);
}

function renderRecentsViewRows(
  params: Parameters<typeof renderDiscordModelPickerRecentsView>[0],
): SerializedComponent[] {
  const rendered = renderDiscordModelPickerRecentsView(params);
  const payload = serializePayload(toDiscordModelPickerMessagePayload(rendered)) as {
    components?: SerializedComponent[];
  };
  return extractContainerRows(payload.components);
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

describe("loadDiscordModelPickerData", () => {
  it("reuses buildModelsProviderData as source of truth with agent scope", async () => {
    const expected = createModelsProviderData({ openai: ["gpt-4o"] });
    const cfg = {} as OpenClawConfig;
    buildModelsProviderDataMock.mockResolvedValue(expected);

    const result = await loadDiscordModelPickerData(cfg, "support");

    expect(buildModelsProviderDataMock).toHaveBeenCalledTimes(1);
    expect(buildModelsProviderDataMock).toHaveBeenCalledWith(cfg, "support");
    expect(result).toBe(expected);
  });
});

describe("Discord model picker custom_id", () => {
  it("encodes and decodes command/provider/page/user context", () => {
    const customId = buildDiscordModelPickerCustomId({
      command: "models",
      action: "provider",
      view: "models",
      provider: "OpenAI",
      page: 3,
      userId: "1234567890",
    });

    const parsed = parseDiscordModelPickerCustomId(customId);

    expect(parsed).toEqual({
      command: "models",
      action: "provider",
      view: "models",
      provider: "openai",
      page: 3,
      userId: "1234567890",
    });
  });

  it("parses component data payloads", () => {
    const parsed = parseDiscordModelPickerData({
      cmd: "model",
      act: "back",
      view: "providers",
      u: "42",
      p: "anthropic",
      pg: "2",
    });

    expect(parsed).toEqual({
      command: "model",
      action: "back",
      view: "providers",
      userId: "42",
      provider: "anthropic",
      page: 2,
    });
  });

  it("parses compact custom_id aliases", () => {
    const parsed = parseDiscordModelPickerData({
      c: "models",
      a: "submit",
      v: "models",
      u: "42",
      p: "openai",
      g: "3",
      mi: "2",
    });

    expect(parsed).toEqual({
      command: "models",
      action: "submit",
      view: "models",
      userId: "42",
      provider: "openai",
      page: 3,
      modelIndex: 2,
    });
  });

  it("parses optional submit model index", () => {
    const parsed = parseDiscordModelPickerData({
      cmd: "models",
      act: "submit",
      view: "models",
      u: "42",
      p: "openai",
      pg: "1",
      mi: "7",
    });

    expect(parsed).toEqual({
      command: "models",
      action: "submit",
      view: "models",
      userId: "42",
      provider: "openai",
      page: 1,
      modelIndex: 7,
    });
  });

  it("rejects invalid command/action/view values", () => {
    expect(
      parseDiscordModelPickerData({
        cmd: "status",
        act: "nav",
        view: "providers",
        u: "42",
      }),
    ).toBeNull();
    expect(
      parseDiscordModelPickerData({
        cmd: "model",
        act: "unknown",
        view: "providers",
        u: "42",
      }),
    ).toBeNull();
    expect(
      parseDiscordModelPickerData({
        cmd: "model",
        act: "nav",
        view: "unknown",
        u: "42",
      }),
    ).toBeNull();
  });

  it("enforces Discord custom_id max length", () => {
    const longProvider = `provider-${"x".repeat(DISCORD_CUSTOM_ID_MAX_CHARS)}`;
    expect(() =>
      buildDiscordModelPickerCustomId({
        command: "model",
        action: "provider",
        view: "models",
        provider: longProvider,
        page: 1,
        userId: "42",
      }),
    ).toThrow(/custom_id exceeds/i);
  });

  it("keeps typical submit ids under Discord max length", () => {
    const customId = buildDiscordModelPickerCustomId({
      command: "models",
      action: "submit",
      view: "models",
      provider: "azure-openai-responses",
      page: 1,
      providerPage: 1,
      modelIndex: 10,
      userId: "12345678901234567890",
    });

    expect(customId.length).toBeLessThanOrEqual(DISCORD_CUSTOM_ID_MAX_CHARS);
  });
});

describe("provider paging", () => {
  it("keeps providers on a single page when count fits Discord button rows", () => {
    const entries: Record<string, string[]> = {};
    for (let i = 1; i <= DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX - 2; i += 1) {
      entries[`provider-${String(i).padStart(2, "0")}`] = [`model-${i}`];
    }
    const data = createModelsProviderData(entries);

    const page = getDiscordModelPickerProviderPage({ data, page: 1 });

    expect(page.items).toHaveLength(DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX - 2);
    expect(page.totalPages).toBe(1);
    expect(page.pageSize).toBe(DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX);
    expect(page.hasPrev).toBe(false);
    expect(page.hasNext).toBe(false);
  });

  it("paginates providers when count exceeds one-page Discord button limits", () => {
    const entries: Record<string, string[]> = {};
    for (let i = 1; i <= DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX + 3; i += 1) {
      entries[`provider-${String(i).padStart(2, "0")}`] = [`model-${i}`];
    }
    const data = createModelsProviderData(entries);

    const page1 = getDiscordModelPickerProviderPage({ data, page: 1 });
    const lastPage = getDiscordModelPickerProviderPage({ data, page: 99 });

    expect(page1.items).toHaveLength(DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE);
    expect(page1.totalPages).toBe(2);
    expect(page1.hasNext).toBe(true);

    expect(lastPage.page).toBe(2);
    expect(lastPage.items).toHaveLength(8);
    expect(lastPage.hasPrev).toBe(true);
    expect(lastPage.hasNext).toBe(false);
  });

  it("caps custom provider page size at Discord-safe max", () => {
    const compactData = createModelsProviderData({
      anthropic: ["claude-sonnet-4-5"],
      openai: ["gpt-4o"],
      google: ["gemini-3-pro"],
    });
    const compactPage = getDiscordModelPickerProviderPage({
      data: compactData,
      page: 1,
      pageSize: 999,
    });
    expect(compactPage.pageSize).toBe(DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX);

    const pagedEntries: Record<string, string[]> = {};
    for (let i = 1; i <= DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX + 1; i += 1) {
      pagedEntries[`provider-${String(i).padStart(2, "0")}`] = [`model-${i}`];
    }
    const pagedData = createModelsProviderData(pagedEntries);
    const pagedPage = getDiscordModelPickerProviderPage({
      data: pagedData,
      page: 1,
      pageSize: 999,
    });
    expect(pagedPage.pageSize).toBe(DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE);
  });
});

describe("model paging", () => {
  it("sorts models and paginates with Discord select-option constraints", () => {
    const models = Array.from(
      { length: DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE + 4 },
      (_, idx) =>
        `model-${String(DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE + 4 - idx).padStart(2, "0")}`,
    );
    const data = createModelsProviderData({ openai: models });

    const page1 = requireValue(
      getDiscordModelPickerModelPage({ data, provider: "openai", page: 1 }),
      "expected first model page for openai",
    );
    const page2 = requireValue(
      getDiscordModelPickerModelPage({ data, provider: "openai", page: 2 }),
      "expected second model page for openai",
    );

    expect(page1.items).toHaveLength(DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE);
    expect(page1.items[0]).toBe("model-01");
    expect(page1.hasNext).toBe(true);

    expect(page2.items).toHaveLength(4);
    expect(page2.page).toBe(2);
    expect(page2.hasPrev).toBe(true);
    expect(page2.hasNext).toBe(false);
  });

  it("returns null for unknown provider", () => {
    const data = createModelsProviderData({ anthropic: ["claude-sonnet-4-5"] });
    const page = getDiscordModelPickerModelPage({ data, provider: "openai", page: 1 });
    expect(page).toBeNull();
  });

  it("caps custom model page size at Discord select-option max", () => {
    const data = createModelsProviderData({ openai: ["gpt-4o", "gpt-4.1"] });
    const page = requireValue(
      getDiscordModelPickerModelPage({ data, provider: "openai", pageSize: 999 }),
      "expected model page when provider exists",
    );
    expect(page.pageSize).toBe(DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE);
  });
});

describe("Discord model picker rendering", () => {
  it("renders provider view on one page when provider count is <= 25", () => {
    const entries: Record<string, string[]> = {};
    for (let i = 1; i <= 22; i += 1) {
      entries[`provider-${String(i).padStart(2, "0")}`] = [`model-${i}`];
    }
    entries["azure-openai-responses"] = ["gpt-4.1"];
    entries["vercel-ai-gateway"] = ["gpt-4o-mini"];
    const data = createModelsProviderData(entries);

    const rendered = renderDiscordModelPickerProvidersView({
      command: "models",
      userId: "42",
      data,
      currentModel: "provider-01/model-1",
    });

    const payload = serializePayload(toDiscordModelPickerMessagePayload(rendered)) as {
      content?: string;
      components?: SerializedComponent[];
    };

    expect(payload.content).toBeUndefined();
    const firstComponent = requireValue(
      payload.components?.[0],
      "provider view should render a container component",
    );
    expect(firstComponent.type).toBe(ComponentType.Container);

    const rows = extractContainerRows(payload.components);
    expect(rows.length).toBeGreaterThan(0);

    const rowProviderCounts = rows.map(
      (row) =>
        (row.components ?? []).filter((component) => {
          const parsed = parseDiscordModelPickerCustomId(component.custom_id ?? "");
          return parsed?.action === "provider";
        }).length,
    );
    expect(rowProviderCounts).toEqual([4, 5, 5, 5, 5]);

    const allButtons = rows.flatMap((row) => row.components ?? []);
    const providerButtons = allButtons.filter((component) => {
      const parsed = parseDiscordModelPickerCustomId(component.custom_id ?? "");
      return parsed?.action === "provider";
    });
    expect(providerButtons).toHaveLength(Object.keys(entries).length);
    expect(allButtons.some((component) => (component.custom_id ?? "").includes(";a=nav;"))).toBe(
      false,
    );
  });

  it("does not render navigation buttons even when provider count exceeds one page", () => {
    const entries: Record<string, string[]> = {};
    for (let i = 1; i <= DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX + 4; i += 1) {
      entries[`provider-${String(i).padStart(2, "0")}`] = [`model-${i}`];
    }
    const data = createModelsProviderData(entries);

    const rendered = renderDiscordModelPickerProvidersView({
      command: "models",
      userId: "42",
      data,
      currentModel: "provider-01/model-1",
    });

    const payload = serializePayload(toDiscordModelPickerMessagePayload(rendered)) as {
      components?: SerializedComponent[];
    };

    const rows = extractContainerRows(payload.components);
    expect(rows.length).toBeGreaterThan(0);

    const allButtons = rows.flatMap((row) => row.components ?? []);
    expect(allButtons.some((component) => (component.custom_id ?? "").includes(";a=nav;"))).toBe(
      false,
    );
  });

  it("supports classic fallback rendering with content + action rows", () => {
    const data = createModelsProviderData({ openai: ["gpt-4o"], anthropic: ["claude-sonnet-4-5"] });

    const rendered = renderDiscordModelPickerProvidersView({
      command: "model",
      userId: "99",
      data,
      layout: "classic",
    });

    const payload = serializePayload(toDiscordModelPickerMessagePayload(rendered)) as {
      content?: string;
      components?: SerializedComponent[];
    };

    expect(payload.content).toContain("Model Picker");
    const firstComponent = requireValue(
      payload.components?.[0],
      "classic provider view should render an action row",
    );
    expect(firstComponent.type).toBe(ComponentType.ActionRow);
  });

  it("preserves the stored model suffix spacing in Discord current-model text", () => {
    const data = createModelsProviderData({ openai: [" gpt-5", "gpt-4o"] });

    const rendered = renderDiscordModelPickerProvidersView({
      command: "model",
      userId: "99",
      data,
      currentModel: " OpenAI/ gpt-5 ",
      layout: "classic",
    });

    const payload = serializePayload(toDiscordModelPickerMessagePayload(rendered)) as {
      content?: string;
    };

    expect(payload.content).toContain("Current model: openai/ gpt-5");
  });

  it("renders model view with select menu and explicit submit button", () => {
    const data = createModelsProviderData({
      openai: ["gpt-4.1", "gpt-4o", "o3"],
      anthropic: ["claude-sonnet-4-5"],
    });

    const rendered = renderDiscordModelPickerModelsView({
      command: "models",
      userId: "42",
      data,
      provider: "openai",
      page: 1,
      providerPage: 2,
      currentModel: "openai/gpt-4o",
      pendingModel: "openai/o3",
      pendingModelIndex: 3,
    });

    const payload = serializePayload(toDiscordModelPickerMessagePayload(rendered)) as {
      components?: SerializedComponent[];
    };

    const rows = extractContainerRows(payload.components);
    expect(rows).toHaveLength(3);

    const providerSelect = rows[0]?.components?.find(
      (component) => component.type === DISCORD_STRING_SELECT_COMPONENT_TYPE,
    );
    if (!providerSelect) {
      throw new Error("models view did not render a provider select");
    }
    expect(providerSelect.options?.length).toBe(2);
    expect(providerSelect.options?.find((option) => option.value === "openai")?.default).toBe(true);
    const parsedProviderState = parseDiscordModelPickerCustomId(providerSelect.custom_id ?? "");
    expect(parsedProviderState?.action).toBe("provider");

    const modelSelect = rows[1]?.components?.find(
      (component) => component.type === DISCORD_STRING_SELECT_COMPONENT_TYPE,
    );
    if (!modelSelect) {
      throw new Error("models view did not render a model select");
    }
    expect(modelSelect.options?.length).toBe(3);
    expect(modelSelect.options?.find((option) => option.value === "o3")?.default).toBe(true);

    const parsedModelSelectState = parseDiscordModelPickerCustomId(modelSelect.custom_id ?? "");
    expect(parsedModelSelectState?.action).toBe("model");
    expect(parsedModelSelectState?.provider).toBe("openai");

    const navButtons = rows[2]?.components ?? [];
    expect(navButtons).toHaveLength(3);

    const cancelState = parseDiscordModelPickerCustomId(navButtons[0]?.custom_id ?? "");
    expect(cancelState?.action).toBe("cancel");

    const resetState = parseDiscordModelPickerCustomId(navButtons[1]?.custom_id ?? "");
    expect(resetState?.action).toBe("reset");
    expect(resetState?.provider).toBe("openai");

    const submitState = parseDiscordModelPickerCustomId(navButtons[2]?.custom_id ?? "");
    expect(submitState?.action).toBe("submit");
    expect(submitState?.provider).toBe("openai");
    expect(submitState?.modelIndex).toBe(3);
  });

  it("renders not-found model view with a back button", () => {
    const data = createModelsProviderData({ openai: ["gpt-4o"] });

    const rendered = renderDiscordModelPickerModelsView({
      command: "model",
      userId: "42",
      data,
      provider: "does-not-exist",
      providerPage: 3,
    });

    const payload = serializePayload(toDiscordModelPickerMessagePayload(rendered)) as {
      components?: SerializedComponent[];
    };

    const rows = extractContainerRows(payload.components);
    expect(rows).toHaveLength(1);

    const backButton = requireValue(
      rows[0]?.components?.[0],
      "models view should render a back button row",
    );
    expect(backButton.type).toBe(ComponentType.Button);

    const state = requireValue(
      parseDiscordModelPickerCustomId(backButton.custom_id ?? ""),
      "back button custom id should parse",
    );
    expect(state.action).toBe("back");
    expect(state.view).toBe("providers");
    expect(state.page).toBe(3);
  });

  it("shows Recents button when quickModels are provided", () => {
    const data = createModelsProviderData({
      openai: ["gpt-4.1", "gpt-4o"],
      anthropic: ["claude-sonnet-4-5"],
    });

    const rows = renderModelsViewRows({
      command: "model",
      userId: "42",
      data,
      provider: "openai",
      page: 1,
      providerPage: 1,
      currentModel: "openai/gpt-4o",
      quickModels: ["openai/gpt-4o", "anthropic/claude-sonnet-4-5"],
    });
    const buttonRow = rows[2];
    const buttons = buttonRow?.components ?? [];
    expect(buttons).toHaveLength(4);

    const favoritesState = requireValue(
      parseDiscordModelPickerCustomId(buttons[2]?.custom_id ?? ""),
      "recents button custom id should parse",
    );
    expect(favoritesState.action).toBe("recents");
    expect(favoritesState.view).toBe("recents");
  });

  it("omits Recents button when no quickModels", () => {
    const data = createModelsProviderData({
      openai: ["gpt-4.1", "gpt-4o"],
    });

    const rows = renderModelsViewRows({
      command: "model",
      userId: "42",
      data,
      provider: "openai",
      page: 1,
      providerPage: 1,
      currentModel: "openai/gpt-4o",
    });
    const buttonRow = rows[2];
    const buttons = buttonRow?.components ?? [];
    expect(buttons).toHaveLength(3);

    const allActions = buttons.map(
      (b) => parseDiscordModelPickerCustomId(b?.custom_id ?? "")?.action,
    );
    expect(allActions).not.toContain("recents");
  });
});

describe("Discord model picker recents view", () => {
  it("renders one button per model with back button after divider", () => {
    const data = createModelsProviderData({
      openai: ["gpt-4.1", "gpt-4o"],
      anthropic: ["claude-sonnet-4-5"],
    });

    // Default is openai/gpt-4.1 (first key in entries).
    // Neither quickModel matches, so no deduping — 1 default + 2 recents + 1 back = 4 rows.
    const rows = renderRecentsViewRows({
      command: "model",
      userId: "42",
      data,
      quickModels: ["openai/gpt-4o", "anthropic/claude-sonnet-4-5"],
      currentModel: "openai/gpt-4o",
    });
    expect(rows).toHaveLength(4);

    // First row: default model button (slot 1).
    const defaultBtn = requireValue(
      rows[0]?.components?.[0],
      "recents view should render a default model button",
    );
    expect(defaultBtn.type).toBe(ComponentType.Button);
    const defaultState = requireValue(
      parseDiscordModelPickerCustomId(defaultBtn.custom_id ?? ""),
      "default recents button custom id should parse",
    );
    expect(defaultState.action).toBe("submit");
    expect(defaultState.view).toBe("recents");
    expect(defaultState.recentSlot).toBe(1);

    // Second row: first recent (slot 2).
    const recentBtn1 = requireValue(
      rows[1]?.components?.[0],
      "recents view should render first recent button",
    );
    const recentState1 = requireValue(
      parseDiscordModelPickerCustomId(recentBtn1.custom_id ?? ""),
      "first recent custom id should parse",
    );
    expect(recentState1.recentSlot).toBe(2);

    // Third row: second recent (slot 3).
    const recentBtn2 = requireValue(
      rows[2]?.components?.[0],
      "recents view should render second recent button",
    );
    const recentState2 = requireValue(
      parseDiscordModelPickerCustomId(recentBtn2.custom_id ?? ""),
      "second recent custom id should parse",
    );
    expect(recentState2.recentSlot).toBe(3);

    // Fourth row (after divider): Back button.
    const backBtn = requireValue(
      rows[3]?.components?.[0],
      "recents view should render a back button",
    );
    const backState = requireValue(
      parseDiscordModelPickerCustomId(backBtn.custom_id ?? ""),
      "recents back button custom id should parse",
    );
    expect(backState.action).toBe("back");
    expect(backState.view).toBe("models");
  });

  it("includes (default) suffix on default model button label", () => {
    const data = createModelsProviderData({
      openai: ["gpt-4o"],
    });

    const rows = renderRecentsViewRows({
      command: "model",
      userId: "42",
      data,
      quickModels: ["openai/gpt-4o"],
      currentModel: "openai/gpt-4o",
    });
    const defaultBtn = requireValue(
      rows[0]?.components?.[0] as { label?: string } | undefined,
      "recents default row should include a button",
    );
    expect(defaultBtn.label).toContain("(default)");
  });

  it("deduplicates recents that match the default model", () => {
    const data = createModelsProviderData({
      openai: ["gpt-4o"],
      anthropic: ["claude-sonnet-4-5"],
    });
    // Default is openai/gpt-4o (first key). quickModels contains the default.
    const rows = renderRecentsViewRows({
      command: "model",
      userId: "42",
      data,
      quickModels: ["openai/gpt-4o", "anthropic/claude-sonnet-4-5"],
      currentModel: "openai/gpt-4o",
    });
    // 1 default + 1 deduped recent + 1 back = 3 rows (openai/gpt-4o not shown twice)
    expect(rows).toHaveLength(3);

    const defaultBtn = requireValue(
      rows[0]?.components?.[0] as { label?: string } | undefined,
      "deduped recents should keep the default button",
    );
    expect(defaultBtn.label).toContain("openai/gpt-4o");
    expect(defaultBtn.label).toContain("(default)");

    const recentBtn = requireValue(
      rows[1]?.components?.[0] as { label?: string } | undefined,
      "deduped recents should keep the non-default recent button",
    );
    expect(recentBtn.label).toContain("anthropic/claude-sonnet-4-5");
  });
});
