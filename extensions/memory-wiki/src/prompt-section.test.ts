// Memory Wiki tests cover synchronous guidance and async compiled prompt preparation.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import {
  activateMemoryWikiCompiledCacheOwner,
  configureMemoryWikiCompiledCacheStore,
  createMemoryWikiCompiledCachePublicationId,
  resolveMemoryWikiCompiledCacheGeneration,
  writeMemoryWikiCompiledCache,
  type MemoryWikiCompiledCacheSnapshot,
  type MemoryWikiCompiledDigestClaim,
  type MemoryWikiCompiledDigestPage,
} from "./compiled-cache.js";
import {
  resolveMemoryWikiAgentConfig,
  resolveMemoryWikiConfig,
  type ResolvedMemoryWikiConfig,
} from "./config.js";
import {
  appendMemoryWikiLog,
  ensureMemoryWikiVaultGeneration,
  loadMemoryWikiValidatedVaultIdentity,
  loadMemoryWikiVaultIdentity,
  resolveMemoryWikiVaultSourceGeneration,
} from "./log.js";
import {
  createWikiPromptSectionBuilder,
  createWikiPromptSectionPreparer,
} from "./prompt-section.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { configureCompiledCacheStore } = createMemoryWikiTestHarness();
let suiteRoot = "";

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-prompt-suite-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  configureMemoryWikiCompiledCacheStore(undefined);
});

afterAll(async () => {
  if (suiteRoot) {
    await fs.rm(suiteRoot, { recursive: true, force: true });
  }
});

type PromptPageFixture = Pick<MemoryWikiCompiledDigestPage, "title" | "kind" | "claimCount"> &
  Omit<Partial<MemoryWikiCompiledDigestPage>, "topClaims"> & {
    topClaims?: Array<Partial<MemoryWikiCompiledDigestClaim> & { text: string }>;
  };

async function seedCompiledDigest(params: {
  config: ResolvedMemoryWikiConfig;
  claimCount: number;
  contradictionCount?: number;
  pages: PromptPageFixture[];
}): Promise<void> {
  configureCompiledCacheStore();
  await fs.mkdir(path.join(params.config.vault.path, ".openclaw-wiki"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(params.config.vault.path, "WIKI.md"), "# Memory Wiki\n", "utf8"),
    fs.writeFile(path.join(params.config.vault.path, ".openclaw-wiki", "log.jsonl"), "", "utf8"),
  ]);
  activateMemoryWikiCompiledCacheOwner(
    params.config,
    await ensureMemoryWikiVaultGeneration(params.config.vault.path),
  );
  const snapshot: MemoryWikiCompiledCacheSnapshot = {
    digest: {
      claimCount: params.claimCount,
      contradictionCount: params.contradictionCount ?? 0,
      pages: params.pages.map((page, index) => ({
        ...page,
        path: page.path ?? `entities/page-${index}.md`,
        aliases: page.aliases ?? [],
        sourceIds: page.sourceIds ?? [],
        questions: page.questions ?? [],
        contradictions: page.contradictions ?? [],
        bestUsedFor: page.bestUsedFor ?? [],
        notEnoughFor: page.notEnoughFor ?? [],
        relationshipCount: page.relationshipCount ?? 0,
        topRelationships: page.topRelationships ?? [],
        topClaims: (page.topClaims ?? []).map((claim) =>
          Object.assign({ status: "supported", freshnessLevel: "unknown" }, claim),
        ),
      })),
    },
    claims: [],
  };
  const publicationId = createMemoryWikiCompiledCachePublicationId();
  const reservationId = createMemoryWikiCompiledCachePublicationId();
  const parentPublicationId = (await loadMemoryWikiVaultIdentity(params.config.vault.path))
    .compiledCachePublicationId;
  await appendMemoryWikiLog(params.config.vault.path, {
    type: "compile",
    timestamp: "2026-07-17T00:00:00.000Z",
    details: { compiledCacheReservationId: reservationId },
  });
  const sourceGeneration = await resolveMemoryWikiVaultSourceGeneration(params.config.vault.path);
  await appendMemoryWikiLog(params.config.vault.path, {
    type: "compile",
    timestamp: "2026-07-17T00:00:00.000Z",
    details: {
      compiledCachePublicationId: publicationId,
      compiledCacheParentPublicationId: parentPublicationId,
      compiledCacheReservationId: reservationId,
      compiledCacheSourceGeneration: sourceGeneration,
    },
  });
  await writeMemoryWikiCompiledCache(
    params.config,
    snapshot,
    resolveMemoryWikiCompiledCacheGeneration(snapshot),
    publicationId,
    parentPublicationId,
    async () => {},
    async () => {},
    () => loadMemoryWikiValidatedVaultIdentity(params.config.vault.path),
  );
}

function createStaticPreparer(config: ResolvedMemoryWikiConfig) {
  return createWikiPromptSectionPreparer({ config, resolveConfig: () => config });
}

describe("Memory Wiki prompt section", () => {
  const buildGuidance = createWikiPromptSectionBuilder();

  it("prefers shared memory corpus guidance when memory tools are available", () => {
    const lines = buildGuidance({
      availableTools: new Set(["memory_search", "memory_get", "wiki_search", "wiki_get"]),
    });

    expect(lines.join("\n")).toContain("`memory_search` with `corpus=all`");
    expect(lines.join("\n")).toContain("`memory_get` with `corpus=wiki` or `corpus=all`");
    expect(lines.join("\n")).toContain("wiki-specific ranking or provenance details");
  });

  it("stays empty when no wiki or memory-adjacent tools are registered", () => {
    expect(buildGuidance({ availableTools: new Set(["web_search"]) })).toStrictEqual([]);
  });

  it("prepares a compact compiled digest from SQLite", async () => {
    const config = resolveMemoryWikiConfig({
      vault: { path: path.join(suiteRoot, "digest-enabled") },
      context: { includeCompiledDigestPrompt: true },
    });
    await seedCompiledDigest({
      config,
      claimCount: 8,
      contradictionCount: 1,
      pages: [
        {
          title: "Alpha",
          kind: "entity",
          claimCount: 3,
          questions: ["Still active?"],
          contradictions: ["Conflicts with source.beta"],
          topClaims: [
            {
              text: "Alpha uses PostgreSQL for production writes.",
              confidence: 0.91,
              freshnessLevel: "fresh",
            },
          ],
        },
      ],
    });

    const lines = await createStaticPreparer(config)({ availableTools: new Set() });

    expect(lines.join("\n")).toContain("## Compiled Wiki Snapshot");
    expect(lines.join("\n")).toContain(
      "Alpha: entity, 3 claims, 1 open questions, 1 contradiction notes",
    );
    expect(lines.join("\n")).toContain("Alpha uses PostgreSQL for production writes.");
  });

  it("keeps the digest disabled by default", async () => {
    const config = resolveMemoryWikiConfig({
      vault: { path: path.join(suiteRoot, "digest-disabled") },
    });
    await seedCompiledDigest({
      config,
      claimCount: 1,
      pages: [{ title: "Alpha", kind: "entity", claimCount: 1 }],
    });

    await expect(createStaticPreparer(config)({ availableTools: new Set() })).resolves.toEqual([]);
  });

  it("stabilizes digest ordering for prompt-cache-friendly output", async () => {
    const config = resolveMemoryWikiConfig({
      vault: { path: path.join(suiteRoot, "digest-stable") },
      context: { includeCompiledDigestPrompt: true },
    });
    const pages: PromptPageFixture[] = [
      {
        title: "Zulu",
        kind: "concept",
        claimCount: 2,
        topClaims: [{ text: "Zulu fallback note.", confidence: 0.3, freshnessLevel: "stale" }],
      },
      {
        title: "Alpha",
        kind: "entity",
        claimCount: 4,
        questions: ["Still active?"],
        contradictions: ["Conflicts with source.beta"],
        topClaims: [
          { text: "Alpha was renamed in 2026.", confidence: 0.42, freshnessLevel: "aging" },
          {
            text: "Alpha uses PostgreSQL for production writes.",
            confidence: 0.91,
            freshnessLevel: "fresh",
          },
        ],
      },
    ];
    await seedCompiledDigest({ config, claimCount: 6, contradictionCount: 1, pages });
    const firstLines = await createStaticPreparer(config)({ availableTools: new Set() });
    const firstPage = expectDefined(pages[0], "first Memory Wiki digest page");
    const secondPage = expectDefined(pages[1], "second Memory Wiki digest page");
    await seedCompiledDigest({
      config,
      claimCount: 6,
      contradictionCount: 1,
      pages: [{ ...secondPage, topClaims: secondPage.topClaims?.toReversed() }, firstPage],
    });
    const secondLines = await createStaticPreparer(config)({ availableTools: new Set() });

    expect(firstLines).toEqual(secondLines);
    expect(firstLines.join("\n")).toContain(
      "Alpha uses PostgreSQL for production writes. (status supported, confidence 0.91, freshness fresh)",
    );
  });

  it("does no filesystem work during synchronous prompt guidance", () => {
    const readFileSync = vi.spyOn(fsSync, "readFileSync");

    expect(buildGuidance({ availableTools: new Set(["web_search"]) })).toEqual([]);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("prepares only the invoking agent's compiled digest", async () => {
    const rootDir = path.join(suiteRoot, "agent-digests");
    const appConfig = {
      agents: { list: [{ id: "support", default: true }, { id: "marketing" }] },
    } as OpenClawConfig;
    const config = resolveMemoryWikiConfig({
      vault: { scope: "agent", path: rootDir },
      context: { includeCompiledDigestPrompt: true },
    });
    for (const [agentId, marker] of [
      ["support", "SUPPORT_SENTINEL"],
      ["marketing", "MARKETING_SENTINEL"],
    ] as const) {
      const agentConfig = resolveMemoryWikiAgentConfig({ config, appConfig, agentId });
      await seedCompiledDigest({
        config: agentConfig,
        claimCount: 1,
        pages: [
          {
            title: agentId,
            kind: "entity",
            claimCount: 1,
            topClaims: [{ text: marker }],
          },
        ],
      });
    }
    const prepare = createWikiPromptSectionPreparer({
      config,
      resolveConfig: (agentId) => resolveMemoryWikiAgentConfig({ config, appConfig, agentId }),
    });

    const support = await prepare({ availableTools: new Set(), agentId: "support" });
    const marketing = await prepare({ availableTools: new Set(), agentId: "marketing" });

    expect(support.join("\n")).toContain("SUPPORT_SENTINEL");
    expect(support.join("\n")).not.toContain("MARKETING_SENTINEL");
    expect(marketing.join("\n")).toContain("MARKETING_SENTINEL");
    expect(marketing.join("\n")).not.toContain("SUPPORT_SENTINEL");
    await expect(prepare({ availableTools: new Set() })).resolves.toEqual([]);
  });
});
