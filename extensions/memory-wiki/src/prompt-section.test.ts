// Memory Wiki tests cover prompt section plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import {
  resolveMemoryWikiAgentConfig,
  resolveMemoryWikiConfig,
  type ResolvedMemoryWikiConfig,
} from "./config.js";
import { createWikiPromptSectionBuilder } from "./prompt-section.js";

let suiteRoot = "";

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-prompt-suite-"));
});

afterAll(async () => {
  if (suiteRoot) {
    await fs.rm(suiteRoot, { recursive: true, force: true });
  }
});

function createStaticWikiPromptSectionBuilder(config: ResolvedMemoryWikiConfig) {
  return createWikiPromptSectionBuilder({ config, resolveConfig: () => config });
}

const buildDefaultWikiPromptSection = createStaticWikiPromptSectionBuilder(
  resolveMemoryWikiConfig({
    vault: { path: "" },
    context: { includeCompiledDigestPrompt: false },
  }),
);

describe("default wiki prompt section", () => {
  it("prefers shared memory corpus guidance when memory tools are available", () => {
    const lines = buildDefaultWikiPromptSection({
      availableTools: new Set(["memory_search", "memory_get", "wiki_search", "wiki_get"]),
    });

    expect(lines.join("\n")).toContain("`memory_search` with `corpus=all`");
    expect(lines.join("\n")).toContain("`memory_get` with `corpus=wiki` or `corpus=all`");
    expect(lines.join("\n")).toContain("wiki-specific ranking or provenance details");
  });

  it("stays empty when no wiki or memory-adjacent tools are registered", () => {
    expect(
      buildDefaultWikiPromptSection({ availableTools: new Set(["web_search"]) }),
    ).toStrictEqual([]);
  });

  it("can append a compact compiled digest snapshot when enabled", async () => {
    const rootDir = path.join(suiteRoot, "digest-enabled");
    await fs.mkdir(path.join(rootDir, ".openclaw-wiki", "cache"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, ".openclaw-wiki", "cache", "agent-digest.json"),
      JSON.stringify(
        {
          claimCount: 8,
          contradictionClusters: [{ key: "claim.alpha.db" }],
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
                  status: "supported",
                  confidence: 0.91,
                  freshnessLevel: "fresh",
                },
              ],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    const builder = createStaticWikiPromptSectionBuilder(
      resolveMemoryWikiConfig({
        vault: { path: rootDir },
        context: { includeCompiledDigestPrompt: true },
      }),
    );

    const lines = builder({ availableTools: new Set(["web_search"]) });

    expect(lines.join("\n")).toContain("## Compiled Wiki Snapshot");
    expect(lines.join("\n")).toContain(
      "Alpha: entity, 3 claims, 1 open questions, 1 contradiction notes",
    );
    expect(lines.join("\n")).toContain("Alpha uses PostgreSQL for production writes.");
  });

  it("keeps the digest snapshot disabled by default", async () => {
    const rootDir = path.join(suiteRoot, "digest-disabled");
    await fs.mkdir(path.join(rootDir, ".openclaw-wiki", "cache"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, ".openclaw-wiki", "cache", "agent-digest.json"),
      JSON.stringify({
        claimCount: 1,
        pages: [{ title: "Alpha", kind: "entity", claimCount: 1, topClaims: [] }],
      }),
      "utf8",
    );
    const builder = createStaticWikiPromptSectionBuilder(
      resolveMemoryWikiConfig({
        vault: { path: rootDir },
      }),
    );

    expect(builder({ availableTools: new Set(["web_search"]) })).toStrictEqual([]);
  });

  it("stabilizes digest prompt ordering for prompt-cache-friendly output", async () => {
    const rootDir = path.join(suiteRoot, "digest-stable");
    const digestPath = path.join(rootDir, ".openclaw-wiki", "cache", "agent-digest.json");
    await fs.mkdir(path.dirname(digestPath), { recursive: true });

    const builder = createStaticWikiPromptSectionBuilder(
      resolveMemoryWikiConfig({
        vault: { path: rootDir },
        context: { includeCompiledDigestPrompt: true },
      }),
    );

    const firstDigest = {
      claimCount: 6,
      contradictionClusters: [{ key: "claim.alpha.db" }],
      pages: [
        {
          title: "Zulu",
          kind: "concept",
          claimCount: 2,
          questions: [],
          contradictions: [],
          topClaims: [
            {
              text: "Zulu fallback note.",
              confidence: 0.3,
              freshnessLevel: "stale",
            },
          ],
        },
        {
          title: "Alpha",
          kind: "entity",
          claimCount: 4,
          questions: ["Still active?"],
          contradictions: ["Conflicts with source.beta"],
          topClaims: [
            {
              text: "Alpha was renamed in 2026.",
              confidence: 0.42,
              freshnessLevel: "aging",
            },
            {
              text: "Alpha uses PostgreSQL for production writes.",
              confidence: 0.91,
              freshnessLevel: "fresh",
            },
          ],
        },
      ],
    };
    const firstPage = expectDefined(firstDigest.pages[0], "first Memory Wiki digest page");
    const secondPage = expectDefined(firstDigest.pages[1], "second Memory Wiki digest page");
    const secondDigest = {
      ...firstDigest,
      pages: [
        {
          ...secondPage,
          topClaims: secondPage.topClaims.toReversed(),
        },
        firstPage,
      ],
    };

    await fs.writeFile(digestPath, JSON.stringify(firstDigest, null, 2), "utf8");
    const firstLines = builder({ availableTools: new Set(["web_search"]) });

    await fs.writeFile(digestPath, JSON.stringify(secondDigest, null, 2), "utf8");
    const secondLines = builder({ availableTools: new Set(["web_search"]) });

    expect(firstLines).toEqual(secondLines);
    expect(firstLines.join("\n")).toContain(
      "Alpha uses PostgreSQL for production writes. (confidence 0.91, freshness fresh)",
    );
    expect(firstLines.join("\n")).toContain(
      "Alpha was renamed in 2026. (confidence 0.42, freshness aging)",
    );
  });

  it("reads only the invoking agent's compiled digest", async () => {
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
      const digestPath = path.join(
        rootDir,
        agentId,
        ".openclaw-wiki",
        "cache",
        "agent-digest.json",
      );
      await fs.mkdir(path.dirname(digestPath), { recursive: true });
      await fs.writeFile(
        digestPath,
        JSON.stringify({
          claimCount: 1,
          pages: [
            {
              title: agentId,
              kind: "entity",
              claimCount: 1,
              topClaims: [{ text: marker }],
            },
          ],
        }),
        "utf8",
      );
    }
    const builder = createWikiPromptSectionBuilder({
      config,
      resolveConfig: (agentId) => resolveMemoryWikiAgentConfig({ config, appConfig, agentId }),
    });

    const support = builder({ availableTools: new Set(["web_search"]), agentId: "support" });
    const marketing = builder({
      availableTools: new Set(["web_search"]),
      agentId: "marketing",
    });

    expect(support.join("\n")).toContain("SUPPORT_SENTINEL");
    expect(support.join("\n")).not.toContain("MARKETING_SENTINEL");
    expect(marketing.join("\n")).toContain("MARKETING_SENTINEL");
    expect(marketing.join("\n")).not.toContain("SUPPORT_SENTINEL");
    expect(builder({ availableTools: new Set(["web_search"]) })).toStrictEqual([]);
  });
});
