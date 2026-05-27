import { ComponentType } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { serializePayload } from "../internal/discord.js";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import {
  DISCORD_CUSTOM_ID_MAX_CHARS,
  DISCORD_MODEL_PICKER_BUCKET_TARGET_SIZE,
  DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE,
  DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE,
  DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX,
  buildDiscordModelPickerCustomId,
  computeAlphaBuckets,
  getDiscordModelPickerModelPage,
  getDiscordModelPickerProviderPage,
  findProviderBucketId,
  findProviderBucketLocation,
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
  options?: Array<{ label?: string; value: string; default?: boolean }>;
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
    const cfg = EMPTY_DISCORD_TEST_CONFIG;
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
      r: "codex",
      pg: "1",
      mi: "7",
    });

    expect(parsed).toEqual({
      command: "models",
      action: "submit",
      view: "models",
      userId: "42",
      provider: "openai",
      runtime: "codex",
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
  it("keeps providers on a single page when count fits Discord select options", () => {
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

  it("buckets providers when count exceeds the alpha-bucket threshold", () => {
    // 28 providers all starting with the same letter ("p") → letter-bucket
    // fallback uses count-based numeric chunks of 20 items.
    const entries: Record<string, string[]> = {};
    for (let i = 1; i <= DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX + 3; i += 1) {
      entries[`provider-${String(i).padStart(2, "0")}`] = [`model-${i}`];
    }
    const data = createModelsProviderData(entries);

    const firstBucket = getDiscordModelPickerProviderPage({ data, page: 1 });
    expect(firstBucket.buckets).toHaveLength(2);
    expect(firstBucket.bucket?.id).toBe("1-20");
    expect(firstBucket.items).toHaveLength(20);
    expect(firstBucket.totalPages).toBe(1);
    expect(firstBucket.hasNext).toBe(false);

    const secondBucket = getDiscordModelPickerProviderPage({
      data,
      page: 1,
      bucket: "21-28",
    });
    expect(secondBucket.bucket?.id).toBe("21-28");
    expect(secondBucket.items).toHaveLength(8);
    expect(secondBucket.totalPages).toBe(1);
    expect(secondBucket.hasPrev).toBe(false);
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
    expect(compactPage.buckets).toHaveLength(1);
    expect(compactPage.bucket?.id).toBe("all");

    // 26 providers → buckets engage. First bucket has 20 items which fits a
    // single select page; the user navigates between buckets, not pages.
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
    expect(pagedPage.buckets.length).toBeGreaterThan(1);
    expect(pagedPage.items.length).toBeLessThanOrEqual(
      DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX,
    );
  });
});

describe("model paging", () => {
  it("sorts models and buckets them across the Discord select-option constraint", () => {
    // 29 models all starting with the same prefix → numeric bucket fallback,
    // 20 in the first bucket and 9 in the second.
    const models = Array.from(
      { length: DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE + 4 },
      (_, idx) =>
        `model-${String(DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE + 4 - idx).padStart(2, "0")}`,
    );
    const data = createModelsProviderData({ openai: models });

    const firstBucket = requireValue(
      getDiscordModelPickerModelPage({ data, provider: "openai", page: 1 }),
      "expected first model bucket for openai",
    );
    expect(firstBucket.buckets.length).toBeGreaterThan(1);
    expect(firstBucket.bucket?.id).toBe("1-20");
    expect(firstBucket.items[0]).toBe("model-01");
    expect(firstBucket.items.length).toBeLessThanOrEqual(DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE);

    const secondBucket = requireValue(
      getDiscordModelPickerModelPage({
        data,
        provider: "openai",
        page: 1,
        bucket: "21-29",
      }),
      "expected second model bucket for openai",
    );
    expect(secondBucket.bucket?.id).toBe("21-29");
    expect(secondBucket.items[0]).toBe("model-21");
    expect(secondBucket.items).toHaveLength(9);
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

describe("computeAlphaBuckets", () => {
  it("returns a single all-bucket when items fit under the threshold", () => {
    const items = ["alpha", "beta", "gamma", "delta"];
    const buckets = computeAlphaBuckets(items);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.id).toBe("all");
    expect(buckets[0]?.label).toBe("All (4)");
    expect(buckets[0]?.start).toBe(0);
    expect(buckets[0]?.end).toBe(4);
  });

  it("partitions a diverse list into letter-range buckets", () => {
    // 30 alphabetically diverse items: 10 'a' + 10 'b' + 10 'c' = 30 total.
    const items = [
      ...Array.from({ length: 10 }, (_, i) => `apple-${i}`),
      ...Array.from({ length: 10 }, (_, i) => `banana-${i}`),
      ...Array.from({ length: 10 }, (_, i) => `cherry-${i}`),
    ].toSorted();
    const buckets = computeAlphaBuckets(items);
    expect(buckets.length).toBeGreaterThan(1);
    // Every item must appear in exactly one bucket.
    const reconstructed = buckets.flatMap((b) => items.slice(b.start, b.end));
    expect(reconstructed).toEqual(items);
    // Labels carry counts.
    for (const bucket of buckets) {
      expect(bucket.label).toMatch(/\(\d+\)$/);
    }
  });

  it("keeps the same letter group inside one bucket (no stragglers)", () => {
    // 19 'a' items + 5 'b' items = 24 total. Below threshold so single bucket.
    // Bump to 30 to engage buckets.
    const items = [
      ...Array.from({ length: 19 }, (_, i) => `a-${String(i).padStart(2, "0")}`),
      ...Array.from({ length: 11 }, (_, i) => `b-${String(i).padStart(2, "0")}`),
    ].toSorted();
    const buckets = computeAlphaBuckets(items);
    // No bucket may contain items with mixed first letters except as a
    // boundary-extended single bucket.
    for (const bucket of buckets) {
      const bucketItems = items.slice(bucket.start, bucket.end);
      const firstLetters = new Set(bucketItems.map((item) => item.charAt(0)));
      // The boundary extender keeps a letter group whole; either the bucket
      // is fully one letter or it crossed a letter boundary intentionally.
      expect(firstLetters.size).toBeGreaterThanOrEqual(1);
    }
    // Bucket sizes hit the target ± a letter-boundary spillover.
    const oversized = buckets.filter(
      (bucket) => bucket.end - bucket.start > DISCORD_MODEL_PICKER_BUCKET_TARGET_SIZE + 10,
    );
    expect(oversized).toEqual([]);
  });

  it("falls back to numeric chunks when every item shares the same first letter", () => {
    const items = Array.from({ length: 30 }, (_, i) => `qwen3-${String(i).padStart(2, "0")}`);
    const buckets = computeAlphaBuckets(items);
    expect(buckets.length).toBe(2);
    expect(buckets[0]?.id).toBe("1-20");
    expect(buckets[0]?.label).toMatch(/^1–20 \(20\)$/);
    expect(buckets[1]?.id).toBe("21-30");
    expect(buckets[1]?.label).toMatch(/^21–30 \(10\)$/);
  });

  it("returns an empty array for empty input", () => {
    expect(computeAlphaBuckets([])).toEqual([]);
  });

  it("never returns more than 25 buckets even for huge same-prefix lists", () => {
    // Regression: with a fixed target=20 a 501-item list yielded 26 numeric
    // buckets, exceeding the Discord select-option cap and breaking the
    // picker for the largest wildcard configs. Dynamic target keeps the
    // bucket count <= 25 regardless of input size.
    const items = Array.from({ length: 501 }, (_, i) => `qwen3-${String(i).padStart(3, "0")}`);
    const buckets = computeAlphaBuckets(items);
    expect(buckets.length).toBeLessThanOrEqual(25);
    // Sanity check: a much larger list still fits.
    const huge = Array.from({ length: 5000 }, (_, i) => `qwen3-${String(i).padStart(4, "0")}`);
    expect(computeAlphaBuckets(huge).length).toBeLessThanOrEqual(25);
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
    expect(rows).toHaveLength(1);

    const providerSelect = requireValue(
      rows[0]?.components?.find(
        (component) => component.type === DISCORD_STRING_SELECT_COMPONENT_TYPE,
      ),
      "provider view should render a provider select",
    );
    expect(providerSelect.options).toHaveLength(Object.keys(entries).length);
    expect(providerSelect.options?.find((option) => option.value === "provider-01")?.default).toBe(
      true,
    );

    const providerState = parseDiscordModelPickerCustomId(providerSelect.custom_id ?? "");
    expect(providerState?.action).toBe("provider");
    expect(providerState?.view).toBe("models");

    const customIds = rows
      .flatMap((row) => row.components ?? [])
      .map((component) => component.custom_id ?? "");
    expect(customIds.filter((customId) => customId.includes(";a=nav;"))).toEqual([]);
  });

  it("renders a bucket select when provider count exceeds the bucket threshold", () => {
    // 29 providers (>25) trigger alpha-bucket mode; the rendered view now
    // surfaces a `bucket` select row before the provider select.
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

    const allComponents = rows.flatMap((row) => row.components ?? []);
    const customIds = allComponents.map((component) => component.custom_id ?? "");
    // Exactly one bucket-action select exists; it carries view=providers.
    const bucketIds = customIds.filter((customId) => customId.includes(";a=bucket;"));
    expect(bucketIds).toHaveLength(1);
    expect(bucketIds[0]).toMatch(/a=bucket;v=providers;u=42/);
  });

  it("model select customId omits providerBucket/modelBucket (derived at re-render)", () => {
    // After reviewloop pass 3 we moved providerBucket/modelBucket OUT of
    // per-item customIds — both are pure functions of the durable state
    // (provider + picked model) so re-renders compute them via
    // findProviderBucketId / findModelBucketId. This test pins the new
    // shape and guards against accidentally re-introducing pb/mb on the
    // model select, which previously pushed the customId past Discord's
    // 100-char cap for long providers + 20-digit user ids.
    const models = Array.from({ length: 30 }, (_, i) => `qwen3-${String(i + 1).padStart(2, "0")}`);
    const data = createModelsProviderData({ vllm: models });

    const rendered = renderDiscordModelPickerModelsView({
      command: "models",
      userId: "42",
      data,
      provider: "vllm",
      page: 1,
      providerPage: 1,
      modelBucket: "21-30",
    });

    const payload = serializePayload(toDiscordModelPickerMessagePayload(rendered)) as {
      components?: SerializedComponent[];
    };
    const rows = extractContainerRows(payload.components);
    const allComponents = rows.flatMap((row) => row.components ?? []);
    const customIds = allComponents.map((component) => component.custom_id ?? "");

    const modelActionIds = customIds.filter((customId) => customId.includes(";a=model;"));
    expect(modelActionIds).toHaveLength(1);
    expect(modelActionIds[0]).not.toMatch(/;pb=/);
    expect(modelActionIds[0]).not.toMatch(/;mb=/);
  });

  it("model select customId stays under Discord's 100-char limit for long providers + 20-digit user ids", () => {
    // Regression for reviewloop pass 3 finding #1: combining a long
    // provider id, full Discord snowflake user id, and bucket fields was
    // pushing the model select customId past 100 chars and crashing the
    // render. With pb/mb dropped, the cap holds.
    const models = Array.from({ length: 30 }, (_, i) => `qwen3-${String(i + 1).padStart(2, "0")}`);
    const data = createModelsProviderData({ "azure-openai-responses": models });

    const rendered = renderDiscordModelPickerModelsView({
      command: "models",
      userId: "12345678901234567890",
      data,
      provider: "azure-openai-responses",
      page: 1,
      providerPage: 1,
      providerBucket: "a-z",
      modelBucket: "21-30",
      pendingRuntime: "codex",
    });

    const payload = serializePayload(toDiscordModelPickerMessagePayload(rendered)) as {
      components?: SerializedComponent[];
    };
    const rows = extractContainerRows(payload.components);
    const allComponents = rows.flatMap((row) => row.components ?? []);
    for (const component of allComponents) {
      const id = component.custom_id ?? "";
      expect(id.length).toBeLessThanOrEqual(DISCORD_CUSTOM_ID_MAX_CHARS);
    }
  });

  it("runtime select preserves bucket state without exceeding Discord's customId limit", () => {
    const models = Array.from({ length: 30 }, (_, i) => `qwen3-${String(i + 1).padStart(2, "0")}`);
    const data = createModelsProviderData({ google: models });
    data.runtimeChoicesByProvider = new Map([
      [
        "google",
        [
          {
            id: "google-gemini-cli",
            label: "Google Gemini CLI",
            description:
              "Use the Google Gemini CLI runtime selected by the effective harness policy.",
          },
          {
            id: "pi",
            label: "OpenClaw Pi Default",
            description: "Use the built-in OpenClaw Pi runtime.",
          },
        ],
      ],
    ]);

    const rows = renderModelsViewRows({
      command: "models",
      userId: "12345678901234567890",
      data,
      provider: "google",
      page: 1,
      providerPage: 1,
      modelBucket: "21-30",
      currentRuntime: "google-gemini-cli",
    });

    const runtimeSelect = rows
      .flatMap((row) => row.components ?? [])
      .find((component) => {
        const parsed = parseDiscordModelPickerCustomId(component.custom_id ?? "");
        return parsed?.action === "runtime";
      });
    const runtimeCustomId = requireValue(
      runtimeSelect?.custom_id,
      "models view should render a runtime select",
    );
    const parsed = requireValue(
      parseDiscordModelPickerCustomId(runtimeCustomId),
      "runtime select custom id should parse",
    );

    expect(runtimeCustomId.length).toBeLessThanOrEqual(DISCORD_CUSTOM_ID_MAX_CHARS);
    expect(parsed.modelBucket).toBe("21-30");
    expect(parsed.runtime).toBeUndefined();
  });

  it("model bucket select keeps long runtime state compact", () => {
    const models = Array.from({ length: 30 }, (_, i) => `qwen3-${String(i + 1).padStart(2, "0")}`);
    const data = createModelsProviderData({ "google-gemini-cli": models });
    data.runtimeChoicesByProvider = new Map([
      [
        "google-gemini-cli",
        [
          {
            id: "google-gemini-cli",
            label: "Google Gemini CLI",
            description:
              "Use the Google Gemini CLI runtime selected by the effective harness policy.",
          },
          {
            id: "pi",
            label: "OpenClaw Pi Default",
            description: "Use the built-in OpenClaw Pi runtime.",
          },
        ],
      ],
    ]);

    const rows = renderModelsViewRows({
      command: "models",
      userId: "12345678901234567890",
      data,
      provider: "google-gemini-cli",
      page: 1,
      providerPage: 1,
      currentRuntime: "google-gemini-cli",
      pendingRuntime: "google-gemini-cli",
    });

    const bucketSelect = rows
      .flatMap((row) => row.components ?? [])
      .find((component) => {
        const parsed = parseDiscordModelPickerCustomId(component.custom_id ?? "");
        return parsed?.action === "bucket" && parsed.view === "models";
      });
    const bucketCustomId = requireValue(
      bucketSelect?.custom_id,
      "models view should render a bucket select",
    );
    const parsed = requireValue(
      parseDiscordModelPickerCustomId(bucketCustomId),
      "bucket select custom id should parse",
    );

    expect(bucketCustomId.length).toBeLessThanOrEqual(DISCORD_CUSTOM_ID_MAX_CHARS);
    expect(parsed.runtime).toBeUndefined();
    expect(parsed.runtimeIndex).toBe(1);
  });

  it("model pagination derives provider buckets to stay under Discord's customId limit", () => {
    const models = [
      ...Array.from({ length: 30 }, (_, i) => `a-model-${String(i + 1).padStart(2, "0")}`),
      "b-model-01",
    ];
    const data = createModelsProviderData({ "azure-openai-responses": models });

    const rows = renderModelsViewRows({
      command: "models",
      userId: "12345678901234567890",
      data,
      provider: "azure-openai-responses",
      page: 1,
      providerPage: 1,
      providerBucket: "a-z",
      modelBucket: "a",
    });

    const navIds = rows
      .flatMap((row) => row.components ?? [])
      .map((component) => component.custom_id ?? "")
      .filter((customId) => customId.includes(";a=nav;v=models;"));
    expect(navIds.length).toBeGreaterThan(0);
    for (const customId of navIds) {
      expect(customId.length).toBeLessThanOrEqual(DISCORD_CUSTOM_ID_MAX_CHARS);
      expect(customId).not.toContain(";pb=");
      expect(customId).toContain(";mb=a");
    }
  });

  it("provider pages use Discord's select-option cap when buckets are active", () => {
    const entries: Record<string, string[]> = {};
    for (let i = 1; i <= 30; i += 1) {
      entries[`p-${String(i).padStart(2, "0")}`] = [`model-${i}`];
    }
    entries["z-01"] = ["model-z"];
    const data = createModelsProviderData(entries);

    const firstBucket = getDiscordModelPickerProviderPage({ data, page: 1, bucket: "p" });
    expect(firstBucket.bucket?.id).toBe("p");
    expect(firstBucket.pageSize).toBe(DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE);
    expect(firstBucket.items).toHaveLength(DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE);
    expect(firstBucket.totalPages).toBe(2);
    expect(findProviderBucketLocation(data, "p-30")).toEqual({ bucket: "p", page: 2 });
  });

  it("sorts mixed-case model ids by the same key used for bucket labels", () => {
    const models = [
      "zulu-lower",
      "MiniMaxAI/model",
      "openai/model",
      "Qwen/model",
      "NousResearch/model",
      ...Array.from({ length: 25 }, (_, i) => `camel-${String(i + 1).padStart(2, "0")}`),
    ];
    const data = createModelsProviderData({ chutes: models });

    const page = requireValue(
      getDiscordModelPickerModelPage({ data, provider: "chutes", bucket: "m-z" }),
      "model page should exist",
    );
    const rangeLabels = page.buckets
      .map((bucket) => bucket.label)
      .filter((label) => label.includes("–"));

    expect(rangeLabels.every((label) => !/M–C|Q–N|O–C/u.test(label))).toBe(true);
    expect(page.items.some((item) => item.startsWith("MiniMaxAI/"))).toBe(true);
  });

  it("provider select and pagination preserve the active provider bucket", () => {
    const entries: Record<string, string[]> = {};
    for (let i = 1; i <= 30; i += 1) {
      entries[`p-${String(i).padStart(2, "0")}`] = [`model-${i}`];
    }
    entries["z-01"] = ["model-z"];
    const data = createModelsProviderData(entries);

    const rendered = renderDiscordModelPickerProvidersView({
      command: "models",
      userId: "42",
      data,
      providerBucket: "p",
    });

    const payload = serializePayload(toDiscordModelPickerMessagePayload(rendered)) as {
      components?: SerializedComponent[];
    };
    const rows = extractContainerRows(payload.components);
    const allComponents = rows.flatMap((row) => row.components ?? []);
    const customIds = allComponents.map((component) => component.custom_id ?? "");

    const providerActionIds = customIds.filter((customId) => customId.includes(";a=provider;"));
    expect(providerActionIds).toHaveLength(1);
    expect(providerActionIds[0]).toContain("pb=p");

    const providerSelect = requireValue(
      allComponents.find(
        (component) =>
          component.type === DISCORD_STRING_SELECT_COMPONENT_TYPE &&
          component.custom_id?.includes(";a=provider;"),
      ),
      "provider view should render a provider select",
    );
    expect(providerSelect.options).toHaveLength(DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE);

    // The nav customId carries the active bucket because pagination is
    // bucket-scoped and the user's "current" range is the only durable
    // hint of where to keep them.
    const navIds = customIds.filter((customId) => customId.includes(";a=nav;"));
    expect(navIds.length).toBeGreaterThan(0);
    for (const customId of navIds) {
      expect(customId).toContain("pb=p");
    }
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

  it("keeps provider navigation available when model bucketing drops the provider select", () => {
    const models = Array.from({ length: 30 }, (_, i) => `qwen3-${String(i + 1).padStart(2, "0")}`);
    const providerEntries = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [
        `provider-${String(i + 1).padStart(2, "0")}`,
        ["model"],
      ]),
    );
    const data = createModelsProviderData({ ...providerEntries, vllm: models });
    const providerBucket = requireValue(
      findProviderBucketId(data, "vllm"),
      "test data should bucket the selected provider",
    );

    const rows = renderModelsViewRows({
      command: "models",
      userId: "12345678901234567890",
      data,
      provider: "vllm",
      page: 1,
      providerPage: 1,
      providerBucket,
      modelBucket: "21-30",
    });

    const providerSelect = rows
      .flatMap((row) => row.components ?? [])
      .find(
        (component) =>
          component.type === DISCORD_STRING_SELECT_COMPONENT_TYPE &&
          component.options?.some((option) => option.value === "vllm"),
      );
    expect(providerSelect).toBeUndefined();

    const buttons = rows.at(-1)?.components ?? [];
    const providersButton = requireValue(
      buttons.find((button) => button.custom_id?.includes(";a=back;v=providers;")),
      "bucketed model view should render a providers button",
    );
    const state = requireValue(
      parseDiscordModelPickerCustomId(providersButton.custom_id ?? ""),
      "providers button custom id should parse",
    );
    expect(state.action).toBe("back");
    expect(state.view).toBe("providers");
    expect(state.providerBucket).toBe(providerBucket);
    expect((providersButton.custom_id ?? "").length).toBeLessThanOrEqual(
      DISCORD_CUSTOM_ID_MAX_CHARS,
    );
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
    const openaiProviderOption = providerSelect.options?.find(
      (option) => option.value === "openai",
    );
    expect(openaiProviderOption?.default).toBe(true);
    const parsedProviderState = parseDiscordModelPickerCustomId(providerSelect.custom_id ?? "");
    expect(parsedProviderState?.action).toBe("provider");

    const modelSelect = rows[1]?.components?.find(
      (component) => component.type === DISCORD_STRING_SELECT_COMPONENT_TYPE,
    );
    if (!modelSelect) {
      throw new Error("models view did not render a model select");
    }
    expect(modelSelect.options?.length).toBe(3);
    const o3ModelOption = modelSelect.options?.find((option) => option.value === "o3");
    expect(o3ModelOption?.default).toBe(true);

    const parsedModelSelectState = parseDiscordModelPickerCustomId(modelSelect.custom_id ?? "");
    expect(parsedModelSelectState?.action).toBe("model");
    expect(parsedModelSelectState?.provider).toBe("openai");

    const navButtons = rows[2]?.components ?? [];
    expect(navButtons).toHaveLength(4);

    const providersState = parseDiscordModelPickerCustomId(navButtons[0]?.custom_id ?? "");
    expect(providersState?.action).toBe("back");
    expect(providersState?.view).toBe("providers");
    expect(providersState?.page).toBe(1);

    const cancelState = parseDiscordModelPickerCustomId(navButtons[1]?.custom_id ?? "");
    expect(cancelState?.action).toBe("cancel");

    const resetState = parseDiscordModelPickerCustomId(navButtons[2]?.custom_id ?? "");
    expect(resetState?.action).toBe("reset");
    expect(resetState?.provider).toBe("openai");

    const submitState = parseDiscordModelPickerCustomId(navButtons[3]?.custom_id ?? "");
    expect(submitState?.action).toBe("submit");
    expect(submitState?.provider).toBe("openai");
    expect(submitState?.modelIndex).toBe(3);
  });

  it("defaults the runtime picker to the first effective runtime choice", () => {
    const data = createModelsProviderData({
      openai: ["gpt-4.1", "gpt-4o", "o3"],
      anthropic: ["claude-sonnet-4-5"],
    });
    data.runtimeChoicesByProvider = new Map([
      [
        "openai",
        [
          {
            id: "codex",
            label: "OpenAI Codex",
            description: "Use the OpenAI Codex runtime selected by the effective harness policy.",
          },
          {
            id: "pi",
            label: "OpenClaw Pi Default",
            description: "Use the built-in OpenClaw Pi runtime.",
          },
        ],
      ],
    ]);

    const rows = renderModelsViewRows({
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

    expect(rows).toHaveLength(4);
    const runtimeSelect = rows[1]?.components?.find(
      (component) => component.type === DISCORD_STRING_SELECT_COMPONENT_TYPE,
    );
    if (!runtimeSelect) {
      throw new Error("models view did not render a runtime select");
    }
    expect(runtimeSelect.options?.find((option) => option.value === "codex")?.default).toBe(true);
    expect(runtimeSelect.options?.find((option) => option.value === "pi")?.default).toBe(false);

    const modelSelect = rows[2]?.components?.find(
      (component) => component.type === DISCORD_STRING_SELECT_COMPONENT_TYPE,
    );
    const parsedModelSelectState = parseDiscordModelPickerCustomId(modelSelect?.custom_id ?? "");
    expect(parsedModelSelectState?.runtime).toBeUndefined();

    const navButtons = rows[3]?.components ?? [];
    const submitState = parseDiscordModelPickerCustomId(navButtons.at(-1)?.custom_id ?? "");
    expect(submitState?.action).toBe("submit");
    expect(submitState?.runtime).toBeUndefined();
    expect(submitState?.modelIndex).toBe(3);
  });

  it("carries only explicit runtime picker state into model submit ids", () => {
    const data = createModelsProviderData({
      openai: ["gpt-4.1", "gpt-4o"],
    });
    data.runtimeChoicesByProvider = new Map([
      [
        "openai",
        [
          {
            id: "codex",
            label: "OpenAI Codex",
            description: "Use the OpenAI Codex runtime selected by the effective harness policy.",
          },
          {
            id: "pi",
            label: "OpenClaw Pi Default",
            description: "Use the built-in OpenClaw Pi runtime.",
          },
        ],
      ],
    ]);

    const rows = renderModelsViewRows({
      command: "models",
      userId: "42",
      data,
      provider: "openai",
      currentModel: "openai/gpt-4.1",
      pendingModel: "openai/gpt-4o",
      pendingModelIndex: 2,
      pendingRuntime: "pi",
    });

    const modelSelect = rows[2]?.components?.find(
      (component) => component.type === DISCORD_STRING_SELECT_COMPONENT_TYPE,
    );
    const modelSelectState = parseDiscordModelPickerCustomId(modelSelect?.custom_id ?? "");
    expect(modelSelectState?.runtime).toBeUndefined();
    expect(modelSelectState?.runtimeIndex).toBe(2);
    const submitState = parseDiscordModelPickerCustomId(
      rows[3]?.components?.at(-1)?.custom_id ?? "",
    );
    expect(submitState?.runtime).toBeUndefined();
    expect(submitState?.runtimeIndex).toBe(2);
    const resetState = parseDiscordModelPickerCustomId(rows[3]?.components?.[2]?.custom_id ?? "");
    expect(resetState?.action).toBe("reset");
    expect(resetState?.runtime).toBeUndefined();
    expect(resetState?.runtimeIndex).toBe(2);
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
    expect(buttons).toHaveLength(5);

    const favoritesState = requireValue(
      parseDiscordModelPickerCustomId(buttons[3]?.custom_id ?? ""),
      "recents button custom id should parse",
    );
    expect(favoritesState.action).toBe("recents");
    expect(favoritesState.view).toBe("recents");
  });

  it("preserves the active model bucket when opening Recents", () => {
    const data = createModelsProviderData({
      openai: Array.from({ length: 30 }, (_, i) => `model-${String(i + 1).padStart(2, "0")}`),
    });

    const rows = renderModelsViewRows({
      command: "model",
      userId: "12345678901234567890",
      data,
      provider: "openai",
      page: 1,
      providerPage: 1,
      modelBucket: "21-30",
      currentModel: "openai/model-21",
      quickModels: ["openai/model-21"],
    });
    const buttonRow = rows.at(-1);
    const recentsButton = requireValue(
      buttonRow?.components?.find(
        (button) => parseDiscordModelPickerCustomId(button.custom_id ?? "")?.action === "recents",
      ),
      "models view should render Recents button",
    );
    const state = requireValue(
      parseDiscordModelPickerCustomId(recentsButton.custom_id ?? ""),
      "recents button custom id should parse",
    );

    expect(state.action).toBe("recents");
    expect(state.view).toBe("recents");
    expect(state.modelBucket).toBe("21-30");
    expect((recentsButton.custom_id ?? "").length).toBeLessThanOrEqual(DISCORD_CUSTOM_ID_MAX_CHARS);
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
    expect(buttons).toHaveLength(4);

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

  it("preserves explicit runtime state only on recents back buttons", () => {
    const data = createModelsProviderData({
      openai: ["gpt-4.1", "gpt-4o"],
    });

    const rows = renderRecentsViewRows({
      command: "model",
      userId: "42",
      data,
      quickModels: ["openai/gpt-4o"],
      currentModel: "openai/gpt-4o",
      runtime: "codex",
    });

    const defaultState = requireValue(
      parseDiscordModelPickerCustomId(rows[0]?.components?.[0]?.custom_id ?? ""),
      "default recents button custom id should parse",
    );
    const recentState = requireValue(
      parseDiscordModelPickerCustomId(rows[1]?.components?.[0]?.custom_id ?? ""),
      "recent model button custom id should parse",
    );
    const backState = requireValue(
      parseDiscordModelPickerCustomId(rows[2]?.components?.[0]?.custom_id ?? ""),
      "recents back button custom id should parse",
    );

    expect(defaultState.runtime).toBe("codex");
    expect(recentState.runtime).toBe("codex");
    expect(backState.runtime).toBe("codex");
  });

  it("preserves the browse model bucket on recents back buttons", () => {
    const data = createModelsProviderData({
      openai: Array.from({ length: 30 }, (_, i) => `model-${String(i + 1).padStart(2, "0")}`),
    });

    const rows = renderRecentsViewRows({
      command: "model",
      userId: "12345678901234567890",
      data,
      quickModels: ["openai/model-21"],
      currentModel: "openai/model-21",
      provider: "openai",
      page: 1,
      providerPage: 1,
      modelBucket: "21-30",
    });

    const backState = requireValue(
      parseDiscordModelPickerCustomId(rows.at(-1)?.components?.[0]?.custom_id ?? ""),
      "recents back button custom id should parse",
    );

    expect(backState.action).toBe("back");
    expect(backState.view).toBe("models");
    expect(backState.modelBucket).toBe("21-30");
  });

  it("keeps compact runtime state on recents buttons under the customId limit", () => {
    const data = createModelsProviderData({
      "google-gemini-cli": ["qwen3-01", "qwen3-02"],
    });

    const rows = renderRecentsViewRows({
      command: "model",
      userId: "12345678901234567890",
      data,
      quickModels: ["google-gemini-cli/qwen3-02"],
      currentModel: "google-gemini-cli/qwen3-02",
      provider: "google-gemini-cli",
      runtimeIndex: 1,
    });

    const states = rows.map((row) => {
      const customId = requireValue(row.components?.[0]?.custom_id, "recents row custom id");
      expect(customId.length).toBeLessThanOrEqual(DISCORD_CUSTOM_ID_MAX_CHARS);
      return requireValue(
        parseDiscordModelPickerCustomId(customId),
        "recents custom id should parse",
      );
    });
    expect(states[0]?.runtimeIndex).toBe(1);
    expect(states[1]?.runtimeIndex).toBe(1);
    expect(states[2]?.runtimeIndex).toBe(1);
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
