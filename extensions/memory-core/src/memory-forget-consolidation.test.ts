import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DREAMING_MEMORY_BACKUP_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";
import { listMemoryEntryOrigins, recordMemoryEntryOrigins } from "./memory-entry-origins.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import { buildPromotionRecallAnnotations } from "./short-term-promotion-metadata.js";
import {
  applyShortTermPromotions,
  rankShortTermPromotionCandidates,
  readShortTermRecallEntries,
  recordShortTermRecalls,
} from "./short-term-promotion.js";
import { configureMemoryCoreDreamingStateForTests } from "./test-helpers.js";

describe("memory forget", () => {
  let stateDir: string;
  let workspaceDir: string;
  let cfg: OpenClawConfig;

  beforeEach(async () => {
    stateDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-forget-")),
    );
    workspaceDir = path.join(stateDir, "workspace");
    await fs.mkdir(workspaceDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await configureMemoryCoreDreamingStateForTests();
    cfg = {
      agents: { defaults: { workspace: workspaceDir }, list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    resetPluginStateStoreForTests();
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  async function seedSession(sessionId: string): Promise<void> {
    await upsertSessionEntry({
      agentId: "main",
      sessionKey: `agent:main:${sessionId}`,
      entry: { sessionId, updatedAt: 1_000 },
    });
  }

  it.each([
    { action: "merged", failOrigins: false },
    { action: "superseded", failOrigins: false },
    { action: "merged", failOrigins: true },
  ] as const)(
    "preserves workspace deletion lineage for $action (origin failure: $failOrigins)",
    async ({ action, failOrigins }) => {
      cfg = {
        agents: {
          defaults: { workspace: workspaceDir },
          list: [
            { id: "alpha", default: true, workspace: workspaceDir },
            { id: "gamma", workspace: workspaceDir },
            { id: "vacant", workspace: workspaceDir },
          ],
        },
      } as OpenClawConfig;
      await upsertSessionEntry({
        agentId: "gamma",
        sessionKey: "agent:gamma:private-session",
        entry: { sessionId: "private-session", updatedAt: 1_000 },
      });
      const priorEntry = "- The launch code is violet.";
      const snippet =
        action === "merged" ? "The launch code is violet." : "The launch code is cobalt.";
      const memoryPath = path.join(workspaceDir, "MEMORY.md");
      const diaryPath = path.join(workspaceDir, "DREAMS.md");
      await fs.writeFile(diaryPath, "# Dream Diary\nKeep this unrelated diary entry.\n");
      const previousMemory = [
        "# Long-Term Memory",
        ...(action === "superseded" ? ["<!-- openclaw-memory-lineage:launch-code -->"] : []),
        "<!-- openclaw-memory-promotion:retired-entry -->",
        priorEntry,
        "",
      ].join("\n");
      await fs.writeFile(memoryPath, previousMemory);
      const notePath = path.join(workspaceDir, "memory", "2026-08-26.md");
      await fs.mkdir(path.dirname(notePath), { recursive: true });
      await fs.writeFile(notePath, `${snippet}\n`);
      recordMemoryEntryOrigins({
        agentId: "gamma",
        origins: [
          {
            entryKey: "retired-entry",
            agentId: "gamma",
            sessionId: "private-session",
            sessionKey: "agent:gamma:private-session",
            originClass: "owner",
            observedAt: 1_000,
          },
        ],
      });
      const vacantDb = openOpenClawAgentDatabase({ agentId: "vacant" }).db;
      vacantDb.exec("DROP TABLE IF EXISTS memory_entry_origins");
      const nowMs = Date.parse("2026-08-26T12:00:00.000Z");
      await recordShortTermRecalls({
        workspaceDir,
        query: "launch code",
        signalType: "daily",
        nowMs,
        results: [
          {
            path: "memory/2026-08-26.md",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet,
            source: "memory",
            provenance: {
              originClass: "owner",
              sessionKind: "interactive",
              observedAt: nowMs,
              ...(action === "superseded" ? { supersedesKey: "launch-code" } : {}),
            },
            sessionOrigin: {
              agentId: "alpha",
              sessionId: "alpha-session",
              sessionKey: "agent:alpha:alpha-session",
            },
          },
        ],
      });
      const thresholds = { minScore: 0, minRecallCount: 0, minUniqueQueries: 0 };
      const candidates = await rankShortTermPromotionCandidates({
        workspaceDir,
        nowMs,
        ...thresholds,
      });
      const promoted = candidates[0];
      expect(promoted).toBeDefined();
      const resultEntry = `- ${promoted!.snippet} Source: ${promoted!.path}#L1-L1 ${buildPromotionRecallAnnotations(promoted!)}`;
      const output = JSON.stringify({
        memory: `# Long-Term Memory\n${resultEntry}\n`,
        operations: [
          { candidateKey: promoted!.key, action, resultEntry, priorEntries: [priorEntry] },
        ],
      });
      const subagent = {
        run: vi.fn(async () => ({ runId: "shared-consolidation" })),
        waitForRun: vi.fn(async () => ({ status: "ok" })),
        getSessionMessages: vi.fn(async () => ({
          messages: [{ role: "assistant", content: output }],
        })),
        deleteSession: vi.fn(async () => undefined),
      };

      if (failOrigins) {
        openOpenClawAgentDatabase({ agentId: "gamma" }).db.exec(`
          CREATE TRIGGER fail_origin_reservation BEFORE INSERT ON memory_entry_origins
          WHEN NEW.entry_key != 'retired-entry'
          BEGIN SELECT RAISE(ABORT, 'injected origin write failure'); END;
        `);
      }
      const application = applyShortTermPromotions({
        agentId: "alpha",
        workspaceAgentIds: ["vacant", "gamma", "alpha", "gamma"],
        workspaceDir,
        candidates,
        consolidation: { subagent, logger: { info: vi.fn(), warn: vi.fn() } },
        maxPriorEntryLossFraction: 1,
        nowMs,
        ...thresholds,
      });
      if (failOrigins) {
        await expect(application).rejects.toThrow("injected origin write failure");
        await expect(fs.readFile(memoryPath, "utf8")).resolves.toBe(previousMemory);
        expect(
          (await readShortTermRecallEntries({ workspaceDir, nowMs }))[0]?.promotedAt,
        ).toBeUndefined();
        return;
      }
      const applied = await application;

      expect(applied.applied).toBe(1);
      expect(
        listMemoryEntryOrigins({ agentId: "gamma", entryKeys: [promoted!.key] }),
      ).toMatchObject([{ entryKey: promoted!.key, sessionId: "private-session" }]);
      const readBackups = () =>
        readMemoryCoreWorkspaceEntries<{ content: string }>({
          namespace: DREAMING_MEMORY_BACKUP_NAMESPACE,
          workspaceDir,
        });
      expect((await readBackups()).map(({ value }) => value.content)).toEqual([
        expect.stringContaining(priorEntry),
      ]);
      expect(
        vacantDb
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'memory_entry_origins'")
          .get(),
      ).toBeUndefined();

      expect(await fs.readFile(diaryPath, "utf8")).toContain(snippet);
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      resetPluginStateStoreForTests();
      const report = await forgetMemoryEntries({
        cfg,
        agentId: "gamma",
        sessionIds: ["private-session"],
      });
      expect(report).toMatchObject({
        entryKeys: expect.arrayContaining([promoted!.key]),
        artifacts: { memoryEntries: 3, backups: 1 },
      });
      expect(await fs.readFile(memoryPath, "utf8")).not.toContain(snippet);
      expect((await readBackups()).every(({ value }) => !value.content.includes(priorEntry))).toBe(
        true,
      );
      expect(listMemoryEntryOrigins({ agentId: "gamma" })).toEqual([]);
      const diary = await fs.readFile(diaryPath, "utf8");
      expect.soft(diary).not.toContain(priorEntry);
      expect.soft(diary).not.toContain(snippet);
      expect(diary).toContain("Keep this unrelated diary entry.");
      expect(report.refusals).toEqual([]);
      const repeated = await forgetMemoryEntries({
        cfg,
        agentId: "gamma",
        sessionIds: ["private-session"],
      });
      expect(Object.values(repeated.artifacts).every((count) => count === 0)).toBe(true);
    },
  );

  it.each(["DREAMS.md", "dreams.md"])(
    "warns and preserves historical untraceable highlights in %s",
    async (diaryName) => {
      await seedSession("target");
      recordMemoryEntryOrigins({
        agentId: "main",
        origins: [
          {
            entryKey: "historical",
            agentId: "main",
            sessionId: "target",
            sessionKey: "agent:main:target",
            originClass: "owner",
            observedAt: 1_000,
          },
        ],
      });
      const diaryPath = path.join(workspaceDir, diaryName);
      const historical =
        "# Dream Diary\n## Memory Consolidation History\n- Highlights:\n  - `+ <!-- openclaw-memory-promotion:historical -->`\n  - `+ Untraceable historical fact.`\n";
      await fs.writeFile(diaryPath, historical);
      const preview = await forgetMemoryEntries({
        cfg,
        agentId: "main",
        sessionIds: ["target"],
        dryRun: true,
      });
      expect(preview.refusals).toEqual([expect.stringContaining("review them manually")]);
      expect(preview.artifacts.memoryFiles).toBe(0);
      const report = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["target"] });
      expect(report.refusals).toEqual(preview.refusals);
      expect(await fs.readFile(diaryPath, "utf8")).toBe(historical);
      const repeated = await forgetMemoryEntries({
        cfg,
        agentId: "main",
        sessionIds: ["target"],
        dryRun: true,
      });
      expect(repeated.refusals).toEqual(preview.refusals);
    },
  );

  it("removes only the selected historical session highlight, not its following sibling", async () => {
    await seedSession("target");
    const diaryPath = path.join(workspaceDir, "DREAMS.md");
    const selected =
      "  - `+ Session ID: target; Selected private fact.`\n    Selected continuation.";
    const survivor =
      "  - `+ Keep this unrelated historical fact.`\n<!-- openclaw-memory-promotion:unrelated -->\n- Unrelated adjacent marked entry.";
    const heading = "## Memory Consolidation History\n";
    await fs.writeFile(diaryPath, `${heading}${selected}\n${survivor}\n`);
    const report = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["target"] });
    expect(await fs.readFile(diaryPath, "utf8")).toBe(`${heading}${survivor}\n`);
    expect(report.refusals).toEqual([expect.stringContaining("review them manually")]);
  });

  it.each(["## Session ID: target", "Session: saved; Session ID: target;"])(
    "preserves section cleanup for the multiline header %s",
    async (header) => {
      await seedSession("target");
      const diaryPath = path.join(workspaceDir, "DREAMS.md");
      const survivor = "## Other session\n- Keep this separate section.\n";
      await fs.writeFile(
        diaryPath,
        `${header}\n- Selected first line.\n  Selected continuation.\n- Selected second line.\n${survivor}`,
      );
      await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["target"] });
      expect(await fs.readFile(diaryPath, "utf8")).toBe(survivor);
    },
  );

  it("does not warn after removing every traceable historical highlight", async () => {
    await seedSession("target");
    const quote = "User: This exact historical quotation is attributable.";
    const corpusDir = path.join(workspaceDir, "memory", ".dreams", "session-corpus");
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(
      path.join(corpusDir, "day.txt"),
      `[main/sessions/main/target#L1] ${quote}\n`,
    );
    const diaryPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(diaryPath, `## Memory Consolidation History\n  - \`+ ${quote}\`\n`);
    const report = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["target"] });
    expect(report.refusals).toEqual([]);
    expect(await fs.readFile(diaryPath, "utf8")).not.toContain(quote);
  });

  it("removes a marker-addressable plain-append promotion after budget compaction", async () => {
    await seedSession("target");
    const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
    const snippet = "The undisclosed launch code is cobalt.";
    const sourcePath = "memory/2026-08-25.md";
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, sourcePath), `${snippet}\n`);
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      [
        "# Long-Term Memory",
        "Curated operator fact.",
        "",
        "## Promoted From Short-Term Memory (2026-08-24)",
        "<!-- openclaw-memory-promotion:older-entry -->",
        `- ${"x".repeat(500)}`,
        "",
      ].join("\n"),
    );
    await recordShortTermRecalls({
      workspaceDir,
      query: "launch code",
      signalType: "daily",
      nowMs,
      results: [
        {
          path: sourcePath,
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet,
          source: "memory",
          provenance: { originClass: "owner", sessionKind: "interactive", observedAt: nowMs },
          sessionOrigin: {
            agentId: "main",
            sessionId: "target",
            sessionKey: "agent:main:target",
          },
        },
      ],
    });
    const thresholds = { minScore: 0, minRecallCount: 0, minUniqueQueries: 0 };
    const candidates = await rankShortTermPromotionCandidates({
      workspaceDir,
      nowMs,
      ...thresholds,
    });
    const candidateKey = candidates[0]?.key;
    expect(candidateKey).toMatch(/^memory:claim:/);

    const promoted = await applyShortTermPromotions({
      agentId: "main",
      workspaceDir,
      candidates,
      nowMs,
      memoryFileMaxChars: 450,
      ...thresholds,
    });
    expect(promoted.appended).toBe(1);
    expect(promoted.compactedDates).toEqual(["2026-08-24"]);
    const promotedMemory = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
    expect(promotedMemory).toContain(`<!-- openclaw-memory-promotion:${candidateKey} -->`);
    expect(promotedMemory).toContain(snippet);

    const report = await forgetMemoryEntries({
      cfg,
      agentId: "main",
      sessionIds: ["target"],
    });

    expect(report).toMatchObject({
      entryKeys: [candidateKey],
      artifacts: { memoryFiles: 1, memoryEntries: 1, shortTermEntries: 1, originRows: 1 },
    });
    const survivingMemory = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
    expect(survivingMemory).toContain("Curated operator fact.");
    expect(survivingMemory).not.toContain(snippet);
    expect(survivingMemory).not.toContain(candidateKey);
  });
});
