// Covers `models list` promotion decorations: claim tags and the passive
// discovery section fed by the cached promotions feed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maybeRefreshPromotionsFeed, recordPromotionClaim } from "../../infra/promotions-feed.js";
import type { RuntimeEnv } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { applyPromotionClaimTags, printAvailablePromotionsSection } from "./list.promotions.js";
import type { ModelRow } from "./list.types.js";

const NOW = Date.parse("2026-07-05T12:00:00.000Z");

function makeRow(key: string): ModelRow {
  return {
    key,
    name: key,
    input: "text",
    contextWindow: null,
    local: null,
    available: true,
    tags: [],
    missing: false,
  };
}

function makeRuntime() {
  const lines: string[] = [];
  const runtime = {
    log: vi.fn((line: string) => {
      lines.push(line);
    }),
    error: vi.fn(),
  } as unknown as RuntimeEnv;
  return { runtime, lines };
}

function feedPayload(entries: unknown[]) {
  return {
    schemaVersion: 1,
    id: "clawhub-promotions",
    generatedAt: "2026-07-05T00:00:00.000Z",
    sequence: 1,
    expiresAt: "2026-07-06T00:00:00.000Z",
    entries,
  };
}

const liveEntry = {
  type: "promotion",
  slug: "example-models-launch",
  title: "Free Example models",
  blurb: "Limited-time offer.",
  startsAt: NOW - 86_400_000,
  endsAt: NOW + 86_400_000,
  provider: "example-provider",
  models: [{ modelRef: "example-provider/example/model-alpha", alias: "model-alpha" }],
};

async function seedFeedCache(entries: unknown[]) {
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify(feedPayload(entries)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  await maybeRefreshPromotionsFeed({ nowMs: NOW, force: true, fetchImpl });
}

describe("models list promotion decorations", () => {
  let testState: OpenClawTestState;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-list-promotions-",
    });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await testState.cleanup();
  });

  it("tags claimed promo models and flips to ended past the window", () => {
    recordPromotionClaim({
      slug: "example-models-launch",
      provider: "example-provider",
      modelKeys: ["example-provider/example/model-alpha"],
      endsAtMs: NOW + 86_400_000,
      claimedAtMs: NOW,
    });
    recordPromotionClaim({
      slug: "old-offer",
      provider: "example-provider",
      modelKeys: ["example-provider/example/model-old"],
      endsAtMs: NOW - 1,
      claimedAtMs: NOW - 86_400_000,
    });
    const rows = [
      makeRow("example-provider/example/model-alpha"),
      makeRow("example-provider/example/model-old"),
      makeRow("unrelated/model"),
    ];
    applyPromotionClaimTags(rows, NOW);
    expect(rows[0]?.tags).toContain("promo");
    expect(rows[1]?.tags).toContain("promo ended");
    expect(rows[2]?.tags).toHaveLength(0);
  });

  it("prints the available-via-promotion section for unconfigured models", async () => {
    await seedFeedCache([liveEntry]);
    const { runtime, lines } = makeRuntime();
    await printAvailablePromotionsSection({
      configuredKeys: new Set(["other/model"]),
      runtime,
      nowMs: NOW,
    });
    const text = lines.join("\n");
    expect(text).toContain("Available via promotion:");
    expect(text).toContain("Free Example models");
    expect(text).toContain("example-provider/example/model-alpha");
    expect(text).toContain("openclaw promos claim example-models-launch");
    expect(text).toContain("New promotional model offers");
  });

  it("suppresses the section once the promo models are configured and notices once", async () => {
    await seedFeedCache([liveEntry]);
    const configured = new Set(["example-provider/example/model-alpha"]);
    const first = makeRuntime();
    await printAvailablePromotionsSection({
      configuredKeys: configured,
      runtime: first.runtime,
      nowMs: NOW,
    });
    const firstText = first.lines.join("\n");
    expect(firstText).not.toContain("Available via promotion:");
    // Still announces a never-seen offer once, then never again.
    expect(firstText).toContain("New promotional model offers");
    const second = makeRuntime();
    await printAvailablePromotionsSection({
      configuredKeys: configured,
      runtime: second.runtime,
      nowMs: NOW,
    });
    expect(second.lines.join("\n")).toBe("");
  });

  it("renders the section for an empty model list (fresh install)", async () => {
    await seedFeedCache([liveEntry]);
    const { runtime, lines } = makeRuntime();
    await printAvailablePromotionsSection({ configuredKeys: new Set(), runtime, nowMs: NOW });
    const text = lines.join("\n");
    expect(text).toContain("Available via promotion:");
    expect(text).toContain("openclaw promos claim example-models-launch");
  });

  it("stays silent when the cached window has passed", async () => {
    await seedFeedCache([{ ...liveEntry, startsAt: NOW - 2 * 86_400_000, endsAt: NOW - 1 }]);
    const { runtime, lines } = makeRuntime();
    await printAvailablePromotionsSection({
      configuredKeys: new Set(["other/model"]),
      runtime,
      nowMs: NOW,
    });
    expect(lines.join("\n")).toBe("");
  });
});
