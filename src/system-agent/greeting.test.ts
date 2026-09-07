import { describe, expect, it, vi } from "vitest";
import type { ConfigAuditRecord } from "../config/io.audit.js";
import type { SequencedSqliteAuditRecordEntry } from "../infra/sqlite-audit-record-store.js";
import { SYSTEM_AGENT_GREETING_SYSTEM_PROMPT } from "./assistant-prompts.js";
import {
  acknowledgeSystemAgentGreetingDelivery,
  buildSystemAgentGreetingQuestion,
  loadSystemAgentGreetingFacts,
  resolveSystemAgentGreeting,
  SYSTEM_AGENT_EXTERNAL_EDIT_ALERT,
  systemAgentGreetingChannelHealth,
  systemAgentGreetingFactsHash,
  type SystemAgentGreetingCacheRecord,
  type SystemAgentGreetingCacheStore,
  type SystemAgentGreetingFacts,
} from "./greeting.js";
import type { SystemAgentOverview } from "./overview.js";

function createOverview(overrides: Partial<SystemAgentOverview> = {}): SystemAgentOverview {
  return {
    config: { path: "/tmp/openclaw.json", exists: true, valid: true, issues: [], hash: "hash" },
    agents: [{ id: "main", name: "Main", isDefault: true, model: "openai/gpt-5.5" }],
    defaultAgentId: "main",
    defaultModel: "openai/gpt-5.5",
    tools: {
      codex: { command: "codex", found: false },
      claude: { command: "claude", found: false },
      gemini: { command: "gemini", found: false },
      apiKeys: { openai: false, anthropic: false },
    },
    gateway: { url: "ws://127.0.0.1:18789", source: "test", reachable: true },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
    ...overrides,
  };
}

const healthyFacts = (): SystemAgentGreetingFacts => ({
  updateAvailable: null,
  channelHealth: { available: true, degraded: [] },
  recentExternalEdit: false,
  auditSequence: 0,
});

function createCache(
  initial?: Omit<SystemAgentGreetingCacheRecord, "lastSeenAuditSequence"> & {
    lastSeenAuditSequence?: number;
  },
) {
  let record: SystemAgentGreetingCacheRecord | undefined = initial
    ? { lastSeenAuditSequence: 0, ...initial }
    : undefined;
  const store: SystemAgentGreetingCacheStore = {
    latest: vi.fn(() =>
      record ? [{ key: "latest", value: record, createdAt: record.at ?? 0, sequence: 1 }] : [],
    ),
    compareAndSet: vi.fn((_key, expectedValue, value) => {
      if (JSON.stringify(record ?? null) !== JSON.stringify(expectedValue)) {
        return false;
      }
      record = value ?? undefined;
      return true;
    }),
  };
  return { store, read: () => record };
}

function configAuditEntry(
  sequence: number,
  event: ConfigAuditRecord["event"],
): SequencedSqliteAuditRecordEntry<ConfigAuditRecord> {
  return {
    key: `${event}-${sequence}`,
    value: { event, ts: new Date(sequence).toISOString() } as ConfigAuditRecord,
    createdAt: sequence,
    sequence,
  };
}

function createConfigAudit(
  initial: Array<SequencedSqliteAuditRecordEntry<ConfigAuditRecord>> = [],
) {
  const records = [...initial];
  const latest = vi.fn(({ limit, beforeSequence }: { limit: number; beforeSequence?: number }) =>
    records
      .filter((entry) => beforeSequence === undefined || entry.sequence < beforeSequence)
      .toSorted((left, right) => right.sequence - left.sequence)
      .slice(0, limit),
  );
  return {
    store: { latest },
    add: (entry: SequencedSqliteAuditRecordEntry<ConfigAuditRecord>) => records.push(entry),
  };
}

describe("system agent greeting cache", () => {
  it("returns a matching model greeting without calling the planner", async () => {
    const overview = createOverview();
    const facts = healthyFacts();
    const cached: SystemAgentGreetingCacheRecord = {
      lastSeenAuditSequence: 4,
      factsHash: systemAgentGreetingFactsHash(overview, facts),
      text: "All systems nominal.",
      modelRef: "openai/gpt-5.5",
      at: 100,
    };
    const cache = createCache(cached);
    const planner = vi.fn();

    await expect(
      resolveSystemAgentGreeting({
        overview,
        facts,
        planner,
        allowInference: false,
        cacheStore: cache.store,
      }),
    ).resolves.toEqual({ text: cached.text, source: "cache" });
    acknowledgeSystemAgentGreetingDelivery({ auditSequence: 5, cacheStore: cache.store });
    expect(planner).not.toHaveBeenCalled();
    expect(cache.read()?.lastSeenAuditSequence).toBe(5);
  });

  it("uses the template without calling the planner when inference is disabled", async () => {
    const cache = createCache();
    const planner = vi.fn();

    await expect(
      resolveSystemAgentGreeting({
        overview: createOverview(),
        facts: healthyFacts(),
        planner,
        allowInference: false,
        cacheStore: cache.store,
      }),
    ).resolves.toMatchObject({ source: "template" });

    expect(planner).not.toHaveBeenCalled();
    expect(cache.read()).toBeUndefined();
  });

  it("calls the planner once after a state change and replaces the cache", async () => {
    const overview = createOverview();
    const priorFacts = healthyFacts();
    const facts = { ...priorFacts, updateAvailable: "2026.7.20", auditSequence: 6 };
    const cache = createCache({
      factsHash: systemAgentGreetingFactsHash(overview, priorFacts),
      text: "All systems nominal.",
      modelRef: "openai/gpt-5.5",
      at: 100,
    });
    const planner = vi.fn(async () => ({
      text: "I'm steady.\nAn upgrade to 2026.7.20 is ready when you are.",
      modelRef: "openai/gpt-5.5",
    }));

    const result = await resolveSystemAgentGreeting({
      overview,
      facts,
      planner,
      cacheStore: cache.store,
      now: () => 200,
    });

    expect(result.source).toBe("model");
    expect(planner).toHaveBeenCalledOnce();
    expect(planner).toHaveBeenCalledWith(
      expect.objectContaining({ overview, facts, timeoutMs: 20_000 }),
    );
    acknowledgeSystemAgentGreetingDelivery({
      auditSequence: facts.auditSequence,
      cacheStore: cache.store,
    });
    expect(cache.read()).toMatchObject({
      lastSeenAuditSequence: 6,
      factsHash: systemAgentGreetingFactsHash(overview, facts),
      modelRef: "openai/gpt-5.5",
      at: 200,
    });
  });

  it("appends the host-owned edit alert at delivery without caching it", async () => {
    const overview = createOverview();
    const facts = { ...healthyFacts(), recentExternalEdit: true, auditSequence: 9 };
    const planner = vi.fn(async () => ({
      text: "All systems nominal.",
      modelRef: "openai/gpt-5.5",
    }));
    const cache = createCache();

    const result = await resolveSystemAgentGreeting({
      overview,
      facts,
      planner,
      cacheStore: cache.store,
      now: () => 200,
    });

    expect(result.text).toContain(SYSTEM_AGENT_EXTERNAL_EDIT_ALERT);
    // The cache stores only the model text; the alert is delivery-scoped.
    expect(cache.read()?.text).toBe("All systems nominal.");

    const calm = await resolveSystemAgentGreeting({
      overview,
      facts: { ...facts, recentExternalEdit: false },
      planner,
      cacheStore: cache.store,
      now: () => 300,
    });
    expect(calm.source).toBe("cache");
    expect(calm.text).not.toContain(SYSTEM_AGENT_EXTERNAL_EDIT_ALERT);
  });

  it("reports an edit that arrives between the facts read and delivery", () => {
    const cache = createCache({ lastSeenAuditSequence: 10 });
    const audit = createConfigAudit([configAuditEntry(10, "config.write")]);
    const facts = loadSystemAgentGreetingFacts({
      cacheStore: cache.store,
      configAuditStore: audit.store,
    });

    audit.add(configAuditEntry(11, "config.external"));
    acknowledgeSystemAgentGreetingDelivery({
      auditSequence: facts.auditSequence,
      cacheStore: cache.store,
    });

    expect(
      loadSystemAgentGreetingFacts({ cacheStore: cache.store, configAuditStore: audit.store }),
    ).toMatchObject({ auditSequence: 11, recentExternalEdit: true });
  });

  it("keeps a template delivery as cursor-only state, then reports a later edit", async () => {
    const overview = createOverview();
    const cache = createCache();
    const audit = createConfigAudit([configAuditEntry(3, "config.write")]);
    const facts = loadSystemAgentGreetingFacts({
      cacheStore: cache.store,
      configAuditStore: audit.store,
    });

    await expect(
      resolveSystemAgentGreeting({
        overview,
        facts,
        planner: async () => {
          throw new Error("offline");
        },
        cacheStore: cache.store,
      }),
    ).resolves.toMatchObject({ source: "template" });
    acknowledgeSystemAgentGreetingDelivery({
      auditSequence: facts.auditSequence,
      cacheStore: cache.store,
    });
    expect(cache.read()).toEqual({ lastSeenAuditSequence: 3 });

    audit.add(configAuditEntry(4, "config.external"));
    expect(
      loadSystemAgentGreetingFacts({ cacheStore: cache.store, configAuditStore: audit.store }),
    ).toMatchObject({ auditSequence: 4, recentExternalEdit: true });
  });

  it("pages past six internal writes to find an external edit above the watermark", () => {
    const cache = createCache({ lastSeenAuditSequence: 1 });
    const audit = createConfigAudit([
      configAuditEntry(2, "config.external"),
      ...Array.from({ length: 7 }, (_, index) => configAuditEntry(index + 3, "config.write")),
    ]);

    const facts = loadSystemAgentGreetingFacts({
      cacheStore: cache.store,
      configAuditStore: audit.store,
    });

    expect(facts).toMatchObject({ auditSequence: 9, recentExternalEdit: true });
    expect(audit.store.latest).toHaveBeenCalledTimes(2);
    expect(audit.store.latest).toHaveBeenNthCalledWith(2, { limit: 5, beforeSequence: 5 });
  });

  it("acknowledges a delivered edit so the next facts load is clear", () => {
    const cache = createCache({ lastSeenAuditSequence: 1 });
    const audit = createConfigAudit([
      configAuditEntry(2, "config.external"),
      configAuditEntry(3, "config.write"),
    ]);
    const facts = loadSystemAgentGreetingFacts({
      cacheStore: cache.store,
      configAuditStore: audit.store,
    });
    expect(facts.recentExternalEdit).toBe(true);

    acknowledgeSystemAgentGreetingDelivery({
      auditSequence: facts.auditSequence,
      cacheStore: cache.store,
    });

    expect(
      loadSystemAgentGreetingFacts({ cacheStore: cache.store, configAuditStore: audit.store }),
    ).toMatchObject({ auditSequence: 3, recentExternalEdit: false });
  });

  it("coalesces concurrent planner calls for the same facts", async () => {
    const overview = createOverview();
    const facts = healthyFacts();
    const cache = createCache();
    let finishPlan: ((plan: { text: string; modelRef: string }) => void) | undefined;
    const planner = vi.fn(
      () =>
        new Promise<{ text: string; modelRef: string }>((resolve) => {
          finishPlan = resolve;
        }),
    );

    const first = resolveSystemAgentGreeting({ overview, facts, planner, cacheStore: cache.store });
    const second = resolveSystemAgentGreeting({
      overview,
      facts,
      planner,
      cacheStore: cache.store,
    });
    expect(planner).toHaveBeenCalledOnce();
    finishPlan?.({ text: "All systems nominal.", modelRef: "openai/gpt-5.5" });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { text: "All systems nominal.", source: "model" },
      { text: "All systems nominal.", source: "model" },
    ]);
  });

  it("does not let an older in-flight greeting replace newer facts", async () => {
    const overview = createOverview();
    const oldFacts = healthyFacts();
    const newFacts = { ...oldFacts, updateAvailable: "2026.7.20" };
    const cache = createCache();
    let finishOld: ((plan: { text: string; modelRef: string }) => void) | undefined;
    let finishNew: ((plan: { text: string; modelRef: string }) => void) | undefined;
    const oldGreeting = resolveSystemAgentGreeting({
      overview,
      facts: oldFacts,
      planner: () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
      cacheStore: cache.store,
      now: () => 100,
    });
    const newGreeting = resolveSystemAgentGreeting({
      overview,
      facts: newFacts,
      planner: () =>
        new Promise((resolve) => {
          finishNew = resolve;
        }),
      cacheStore: cache.store,
      now: () => 200,
    });

    finishNew?.({ text: "Update 2026.7.20 is ready.", modelRef: "openai/gpt-5.5" });
    await newGreeting;
    finishOld?.({ text: "All systems nominal.", modelRef: "openai/gpt-5.5" });
    await oldGreeting;

    expect(cache.read()).toMatchObject({
      factsHash: systemAgentGreetingFactsHash(overview, newFacts),
      text: "Update 2026.7.20 is ready.",
      at: 200,
    });
  });

  it("timestamps the greeting snapshot before inference begins", async () => {
    const events: string[] = [];
    const cache = createCache();
    await resolveSystemAgentGreeting({
      overview: createOverview(),
      facts: healthyFacts(),
      planner: async () => {
        events.push("planner");
        return { text: "All systems nominal.", modelRef: "openai/gpt-5.5" };
      },
      cacheStore: cache.store,
      now: () => {
        events.push("snapshot");
        return 100;
      },
    });

    expect(events).toEqual(["snapshot", "planner"]);
    expect(cache.read()?.at).toBe(100);
  });

  it("uses a complete uncached template and backs off unchanged model failures", async () => {
    const cache = createCache();
    const overview = createOverview();
    const planner = vi.fn(async () => {
      throw new Error("offline");
    });
    const facts: SystemAgentGreetingFacts = {
      updateAvailable: "2026.7.20",
      channelHealth: { available: true, degraded: ["Telegram"] },
      recentExternalEdit: true,
      auditSequence: 7,
    };

    const result = await resolveSystemAgentGreeting({
      overview,
      facts,
      planner,
      cacheStore: cache.store,
      now: () => 100,
    });
    const repeated = await resolveSystemAgentGreeting({
      overview,
      facts,
      planner,
      cacheStore: cache.store,
      now: () => 200,
    });

    expect(result).toMatchObject({ source: "template" });
    expect(result.text).toContain("caretaker of this gateway");
    expect(result.text).toContain("Update 2026.7.20 is available");
    expect(result.text).toContain("Channels needing attention: Telegram");
    expect(result.text).toContain(SYSTEM_AGENT_EXTERNAL_EDIT_ALERT);
    expect(repeated).toEqual(result);
    expect(planner).toHaveBeenCalledOnce();
    acknowledgeSystemAgentGreetingDelivery({
      auditSequence: facts.auditSequence,
      cacheStore: cache.store,
    });
    expect(cache.read()).toEqual({ lastSeenAuditSequence: 7 });
  });

  it("rejects a model greeting that omits mild facts", async () => {
    const cache = createCache();
    const facts: SystemAgentGreetingFacts = {
      updateAvailable: "2026.7.20",
      channelHealth: { available: true, degraded: ["Telegram"] },
      recentExternalEdit: true,
      auditSequence: 7,
    };
    const result = await resolveSystemAgentGreeting({
      overview: createOverview(),
      facts,
      planner: async () => ({
        text: "All systems nominal.",
        modelRef: "openai/gpt-5.5",
      }),
      cacheStore: cache.store,
      now: () => 100,
    });

    expect(result).toMatchObject({ source: "template" });
    expect(result.text).toContain("Update 2026.7.20 is available");
    expect(result.text).toContain("Telegram");
    expect(result.text).toContain(SYSTEM_AGENT_EXTERNAL_EDIT_ALERT);
    expect(cache.read()).toBeUndefined();
  });

  it("rejects structured output smuggled behind a preamble line", async () => {
    const cache = createCache();
    const result = await resolveSystemAgentGreeting({
      overview: createOverview(),
      facts: healthyFacts(),
      planner: async () => ({
        text: 'Sure:\n{"status":"healthy"}',
        modelRef: "openai/gpt-5.5",
      }),
      cacheStore: cache.store,
      now: () => 100,
    });

    expect(result).toMatchObject({ source: "template" });
    expect(cache.read()?.text).toBeUndefined();
  });

  it("requires an available update's version before caching model text", async () => {
    const cache = createCache();
    const result = await resolveSystemAgentGreeting({
      overview: createOverview(),
      facts: { ...healthyFacts(), updateAvailable: "2026.7.20" },
      planner: async () => ({
        text: "An update is ready when you are.",
        modelRef: "openai/gpt-5.5",
      }),
      cacheStore: cache.store,
      now: () => 100,
    });

    expect(result).toMatchObject({ source: "template" });
    expect(cache.read()).toBeUndefined();
  });

  it("requires every degraded channel label before caching model text", async () => {
    const cache = createCache();
    const result = await resolveSystemAgentGreeting({
      overview: createOverview(),
      facts: {
        ...healthyFacts(),
        channelHealth: { available: true, degraded: ["Telegram", "Discord"] },
      },
      planner: async () => ({
        text: "Telegram needs attention.",
        modelRef: "openai/gpt-5.5",
      }),
      cacheStore: cache.store,
      now: () => 100,
    });

    expect(result).toMatchObject({ source: "template" });
    expect(cache.read()).toBeUndefined();
  });

  it("accepts model text that names every degraded channel", async () => {
    const cache = createCache();
    const result = await resolveSystemAgentGreeting({
      overview: createOverview(),
      facts: {
        ...healthyFacts(),
        channelHealth: { available: true, degraded: ["Telegram", "Discord"] },
      },
      planner: async () => ({
        text: "Telegram and Discord need attention.",
        modelRef: "openai/gpt-5.5",
      }),
      cacheStore: cache.store,
      now: () => 100,
    });

    expect(result).toEqual({
      text: "Telegram and Discord need attention.",
      source: "model",
    });
    expect(cache.read()?.text).toBe("Telegram and Discord need attention.");
  });

  it("requires channel health unavailability before caching model text", async () => {
    const cache = createCache();
    const facts: SystemAgentGreetingFacts = {
      ...healthyFacts(),
      channelHealth: { available: false, degraded: [] },
    };

    const result = await resolveSystemAgentGreeting({
      overview: createOverview(),
      facts,
      planner: async () => ({ text: "All systems nominal.", modelRef: "openai/gpt-5.5" }),
      cacheStore: cache.store,
      now: () => 100,
    });

    expect(result).toMatchObject({ source: "template" });
    expect(result.text).toContain("Channel health is not available yet");
    expect(cache.read()).toBeUndefined();
  });

  it.each([
    {
      name: "missing config",
      overview: createOverview({
        config: {
          path: "/tmp/openclaw.json",
          exists: false,
          valid: false,
          issues: [],
          hash: null,
        },
      }),
      expected: "Config: missing",
    },
    {
      name: "invalid config",
      overview: createOverview({
        config: {
          path: "/tmp/openclaw.json",
          exists: true,
          valid: false,
          issues: ["invalid"],
          hash: null,
        },
      }),
      expected: "Config: invalid",
    },
    {
      name: "unreachable gateway",
      overview: createOverview({
        gateway: { url: "ws://127.0.0.1:18789", source: "test", reachable: false },
      }),
      expected: "Gateway: not reachable",
    },
    {
      name: "missing default model",
      overview: createOverview({ defaultModel: undefined }),
      expected: "Inference is unavailable",
    },
  ])(
    "uses the deterministic template for $name without opening the cache",
    async ({ overview, expected }) => {
      const cache = createCache();
      const planner = vi.fn(async () => ({
        text: "Config setup is complete.",
        modelRef: "openai/gpt-5.5",
      }));
      const result = await resolveSystemAgentGreeting({
        overview,
        facts: healthyFacts(),
        planner,
        cacheStore: cache.store,
        now: () => 100,
      });

      expect(result).toMatchObject({ source: "template" });
      expect(result.text).toContain(expected);
      expect(planner).not.toHaveBeenCalled();
      expect(cache.store.latest).not.toHaveBeenCalled();
      expect(cache.read()).toBeUndefined();
    },
  );

  it("uses the model-free fallback when the optional greeting cache cannot open", async () => {
    const planner = vi.fn();
    const result = await resolveSystemAgentGreeting({
      overview: createOverview(),
      facts: healthyFacts(),
      planner,
      openCache: () => {
        throw new Error("sqlite unavailable");
      },
    });

    expect(result).toMatchObject({ source: "template" });
    expect(result.text).toContain("caretaker of this gateway");
    expect(planner).not.toHaveBeenCalled();
  });

  it("uses the model-free fallback when the greeting cache cannot be read", async () => {
    const planner = vi.fn();
    const result = await resolveSystemAgentGreeting({
      overview: createOverview(),
      facts: healthyFacts(),
      planner,
      cacheStore: {
        latest: () => {
          throw new Error("sqlite corrupt");
        },
        compareAndSet: vi.fn(),
      },
    });

    expect(result).toMatchObject({ source: "template" });
    expect(planner).not.toHaveBeenCalled();
  });

  it("hashes decision fields stably while ignoring diagnostic-only details", () => {
    const facts = {
      ...healthyFacts(),
      channelHealth: { available: true, degraded: ["Telegram", "Discord"] },
    };
    const left = createOverview();
    const right = createOverview({
      config: {
        ...left.config,
        path: "/another/config.json",
        hash: "another-hash",
        issues: ["diagnostic detail"],
      },
      agents: [...left.agents].toReversed(),
      gateway: { ...left.gateway, source: "another source", error: "diagnostic detail" },
    });
    expect(systemAgentGreetingFactsHash(left, facts)).toBe(
      systemAgentGreetingFactsHash(right, {
        ...facts,
        auditSequence: 999,
        channelHealth: { available: true, degraded: ["Discord", "Telegram"] },
      }),
    );
    expect(systemAgentGreetingFactsHash(left, facts)).not.toBe(
      systemAgentGreetingFactsHash(left, {
        ...facts,
        channelHealth: { available: false, degraded: [] },
      }),
    );
  });
});

describe("system agent greeting identity", () => {
  it("identifies OpenClaw as the machine caretaker and describes every mild fact", () => {
    expect(SYSTEM_AGENT_GREETING_SYSTEM_PROMPT).toContain(
      "You are OpenClaw, the system itself — caretaker of this machine's gateway, config, channels, and agents.",
    );
    expect(SYSTEM_AGENT_GREETING_SYSTEM_PROMPT).toContain("nominal systems get one calm line");
    expect(SYSTEM_AGENT_GREETING_SYSTEM_PROMPT).toContain("If an update is available");
    expect(SYSTEM_AGENT_GREETING_SYSTEM_PROMPT).toContain("If channelHealthAvailable is false");
    expect(SYSTEM_AGENT_GREETING_SYSTEM_PROMPT).toContain("If channels are degraded");
    // The external-edit alert is host-appended at delivery; the model prompt
    // must not mention it (double phrasing).
    expect(SYSTEM_AGENT_GREETING_SYSTEM_PROMPT).not.toContain("recentExternalEdit");
  });
});

describe("system agent greeting facts", () => {
  it("treats a missing greeting slot as audit watermark zero", () => {
    const cache = createCache();
    const audit = createConfigAudit([configAuditEntry(1, "config.external")]);

    expect(
      loadSystemAgentGreetingFacts({ cacheStore: cache.store, configAuditStore: audit.store }),
    ).toMatchObject({ auditSequence: 1, recentExternalEdit: true });
  });

  it("uses cached update and health state without probing", () => {
    const facts = loadSystemAgentGreetingFacts({
      cacheStore: createCache({
        factsHash: "old",
        text: "old",
        modelRef: "model",
        at: 100,
      }).store,
      configAuditStore: {
        latest: () => [
          {
            key: "external",
            value: {
              event: "config.external",
              ts: new Date(200).toISOString(),
            } as ConfigAuditRecord,
            createdAt: 200,
            sequence: 2,
          },
        ],
      },
      getUpdateAvailable: () => ({
        currentVersion: "2026.7.19",
        latestVersion: "2026.7.20",
        channel: "latest",
      }),
      getHealthCache: () =>
        ({
          channels: {
            telegram: {
              accountId: "default",
              configured: true,
              healthState: "stale-socket",
            },
          },
          channelLabels: { telegram: "Telegram" },
        }) as never,
    });
    expect(facts).toEqual({
      updateAvailable: "2026.7.20",
      channelHealth: { available: true, degraded: ["Telegram"] },
      recentExternalEdit: true,
      auditSequence: 2,
    });
  });

  it("deduplicates and sorts degraded channel labels", () => {
    const health = systemAgentGreetingChannelHealth({
      channels: {
        telegram: {
          accountId: "primary",
          accounts: {
            primary: { accountId: "primary", configured: true, probe: { ok: false } },
            quiet: { accountId: "quiet", configured: false, healthState: "not-running" },
          },
        },
        discord: { accountId: "default", running: true, connected: false },
        slack: { accountId: "default", configured: true, running: false },
        whatsapp: { accountId: "default", configured: true, running: true, linked: false },
      },
      channelLabels: {
        telegram: "Telegram",
        discord: "Discord",
        slack: "Slack",
        whatsapp: "WhatsApp",
      },
    } as never);
    expect(health).toEqual({
      available: true,
      degraded: ["Discord", "Slack", "Telegram", "WhatsApp"],
    });
  });
});

describe("system agent quick actions", () => {
  it.each([
    {
      name: "healthy",
      overview: createOverview(),
      facts: healthyFacts(),
      replies: ["talk to agent", "audit"],
    },
    {
      name: "gateway unreachable",
      overview: createOverview({
        gateway: { url: "ws://127.0.0.1:18789", source: "test", reachable: false },
      }),
      facts: healthyFacts(),
      replies: ["gateway status", "restart gateway", "talk to agent", "audit"],
    },
    {
      name: "channel health unavailable",
      overview: createOverview(),
      facts: { ...healthyFacts(), channelHealth: { available: false, degraded: [] } },
      replies: ["health", "talk to agent", "audit"],
    },
    {
      name: "missing config",
      overview: createOverview({
        config: {
          path: "/tmp/openclaw.json",
          exists: false,
          valid: true,
          issues: [],
          hash: null,
        },
      }),
      facts: healthyFacts(),
      replies: ["setup", "talk to agent", "audit"],
    },
    {
      name: "invalid config",
      overview: createOverview({
        config: {
          path: "/tmp/openclaw.json",
          exists: true,
          valid: false,
          issues: ["invalid"],
          hash: null,
        },
      }),
      facts: healthyFacts(),
      replies: ["doctor", "talk to agent", "audit"],
    },
    {
      name: "missing model",
      overview: createOverview({ defaultModel: undefined }),
      facts: healthyFacts(),
      replies: ["setup", "audit"],
    },
    {
      name: "update and manual edit",
      overview: createOverview(),
      facts: {
        updateAvailable: "2026.7.20",
        channelHealth: { available: true, degraded: [] },
        recentExternalEdit: true,
        auditSequence: 0,
      },
      replies: ["status", "talk to agent", "audit"],
    },
    {
      name: "degraded channel",
      overview: createOverview(),
      facts: {
        updateAvailable: null,
        channelHealth: { available: true, degraded: ["Telegram"] },
        recentExternalEdit: false,
        auditSequence: 0,
      },
      replies: ["health", "talk to agent", "audit"],
    },
    {
      name: "several exceptional facts",
      overview: createOverview({
        gateway: { url: "ws://127.0.0.1:18789", source: "test", reachable: false },
      }),
      facts: {
        updateAvailable: "2026.7.20",
        channelHealth: { available: true, degraded: ["Telegram"] },
        recentExternalEdit: true,
        auditSequence: 0,
      },
      replies: ["gateway status", "restart gateway", "talk to agent", "audit"],
    },
  ])("builds canonical replies for $name facts", ({ overview, facts, replies }) => {
    const question = buildSystemAgentGreetingQuestion(overview, facts);
    expect(question.header).toBe("Quick actions");
    expect(question.options.map((option) => option.reply)).toEqual(replies);
    expect(question.options.length).toBeGreaterThanOrEqual(2);
    expect(question.options.length).toBeLessThanOrEqual(4);
  });

  it("does not recommend agent handoff for a recent external edit", () => {
    const question = buildSystemAgentGreetingQuestion(createOverview(), {
      ...healthyFacts(),
      recentExternalEdit: true,
    });
    expect(question.options.find((option) => option.reply === "talk to agent")?.recommended).toBe(
      false,
    );
  });
});
