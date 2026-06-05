// Session store skill stripping tests cover omitting skill payloads from persisted state.
import type { MakeDirectoryOptions, Mode, PathLike } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "../../skills/loading/skill-contract.js";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import type { SessionEntry, SessionSkillPromptRef, SessionSkillSnapshot } from "./types.js";

vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

import {
  getSessionSkillPromptRefCacheStatsForTest,
  getValidSessionSkillPromptBlobCacheStatsForTest,
  isSessionSkillPromptBlobReadable,
} from "./skill-prompt-blobs.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  saveSessionStore,
  updateSessionStore,
} from "./store.js";

const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-skills-strip-" });

function makeFixtureSkill(name: string, bodySize = 3000): Skill {
  // 3KB body simulates a realistic SKILL.md.
  const source = `# ${name}\n\n${"x".repeat(bodySize)}`;
  return createCanonicalFixtureSkill({
    name,
    description: `${name} skill description`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    source,
  });
}

function makeSnapshot(skillCount: number): SessionSkillSnapshot {
  const resolved = Array.from({ length: skillCount }, (_, i) => makeFixtureSkill(`skill-${i}`));
  return {
    prompt: "<available_skills>...</available_skills>",
    skills: resolved.map((s) => ({ name: s.name })),
    skillFilter: undefined,
    resolvedSkills: resolved,
    version: 1,
  };
}

function makeSnapshotWithPrompt(prompt: string): SessionSkillSnapshot {
  return {
    ...makeSnapshot(2),
    prompt,
  };
}

function makeEntry(sessionId: string, snapshot?: SessionSkillSnapshot): SessionEntry {
  return {
    sessionId,
    updatedAt: Date.now(),
    skillsSnapshot: snapshot,
  };
}

describe("session store strips resolvedSkills from persistence", () => {
  let testDir: string;
  let storePath: string;
  let savedCacheTtl: string | undefined;

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  beforeEach(async () => {
    testDir = await suiteRootTracker.make("case");
    storePath = path.join(testDir, "sessions.json");
    savedCacheTtl = process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
    process.env.OPENCLAW_SESSION_CACHE_TTL_MS = "0";
    clearSessionStoreCacheForTest();
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
    if (savedCacheTtl === undefined) {
      delete process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
    } else {
      process.env.OPENCLAW_SESSION_CACHE_TTL_MS = savedCacheTtl;
    }
  });

  it("does not write resolvedSkills to disk", async () => {
    const store = {
      "agent:main:test:1": makeEntry("session-1", makeSnapshot(5)),
    };

    await saveSessionStore(storePath, store, { skipMaintenance: true });

    const raw = await fs.readFile(storePath, "utf-8");
    expect(raw).not.toContain("resolvedSkills");
    expect(raw).not.toContain("xxxxx"); // none of the skill source bodies leaked
    const parsed = JSON.parse(raw) as Record<string, SessionEntry>;
    expect(parsed["agent:main:test:1"]?.skillsSnapshot?.resolvedSkills).toBeUndefined();
  });

  it("preserves prompt, skills, skillFilter, and version on roundtrip", async () => {
    const snapshot = makeSnapshot(3);
    snapshot.skillFilter = ["skill-0"];
    const store = {
      "agent:main:test:1": makeEntry("session-1", snapshot),
    };

    await saveSessionStore(storePath, store, { skipMaintenance: true });
    const loaded = loadSessionStore(storePath, { skipCache: true });

    const persistedSnapshot = loaded["agent:main:test:1"]?.skillsSnapshot;
    expect(persistedSnapshot?.prompt).toBe(snapshot.prompt);
    expect(persistedSnapshot?.skills).toEqual(snapshot.skills);
    expect(persistedSnapshot?.skillFilter).toEqual(["skill-0"]);
    expect(persistedSnapshot?.version).toBe(1);
    expect(persistedSnapshot?.resolvedSkills).toBeUndefined();
  });

  it("strips resolvedSkills from a legacy sessions.json on load", async () => {
    // Hand-craft a pre-fix file with embedded resolvedSkills.
    const legacy = {
      "agent:main:test:1": makeEntry("session-1", makeSnapshot(4)),
    };
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    const rawLegacy = JSON.stringify(legacy, null, 2);
    expect(rawLegacy).toContain("resolvedSkills");
    await fs.writeFile(storePath, rawLegacy, "utf-8");

    const loaded = loadSessionStore(storePath, { skipCache: true });
    expect(loaded["agent:main:test:1"]?.skillsSnapshot?.resolvedSkills).toBeUndefined();
    expect(loaded["agent:main:test:1"]?.skillsSnapshot?.prompt).toBe(
      legacy["agent:main:test:1"].skillsSnapshot?.prompt,
    );

    // Saving the loaded record should rewrite the file in stripped form.
    await saveSessionStore(storePath, loaded, { skipMaintenance: true });
    const rawAfter = await fs.readFile(storePath, "utf-8");
    expect(rawAfter).not.toContain("resolvedSkills");
  });

  it("strips resolvedSkills written via updateSessionStore mutator", async () => {
    // Simulate the production hot path where ensureSkillSnapshot puts a
    // freshly-built snapshot (with resolvedSkills) into the store via mutator.
    await updateSessionStore(
      storePath,
      (store) => {
        store["agent:main:test:1"] = makeEntry("session-1", makeSnapshot(6));
      },
      { skipMaintenance: true },
    );

    const raw = await fs.readFile(storePath, "utf-8");
    expect(raw).not.toContain("resolvedSkills");
    const reloaded = loadSessionStore(storePath, { skipCache: true });
    expect(reloaded["agent:main:test:1"]?.skillsSnapshot?.resolvedSkills).toBeUndefined();
    expect(reloaded["agent:main:test:1"]?.skillsSnapshot?.skills).toHaveLength(6);
  });

  it("keeps the on-disk file small with many sessions and skills", async () => {
    const SESSION_COUNT = 100;
    const SKILLS_PER_SESSION = 50;
    const store: Record<string, SessionEntry> = {};
    for (let i = 0; i < SESSION_COUNT; i += 1) {
      store[`agent:main:scale:${i}`] = makeEntry(`session-${i}`, makeSnapshot(SKILLS_PER_SESSION));
    }

    await saveSessionStore(storePath, store, { skipMaintenance: true });

    const stat = await fs.stat(storePath);
    // Pre-fix: ~SESSION_COUNT * SKILLS_PER_SESSION * ~3KB ≈ 15MB.
    // Post-fix: only the lightweight `skills` array + prompt per entry.
    // Conservative budget that comfortably covers metadata growth.
    expect(stat.size).toBeLessThan(2 * 1024 * 1024);
  });

  it("stores duplicate large skills prompts as content-addressed blobs", async () => {
    const prompt = `<available_skills>\n${"skill prompt body\n".repeat(200)}</available_skills>`;
    const store = {
      "agent:main:test:1": makeEntry("session-1", makeSnapshotWithPrompt(prompt)),
      "agent:main:test:2": makeEntry("session-2", makeSnapshotWithPrompt(prompt)),
    };

    await saveSessionStore(storePath, store, { skipMaintenance: true });

    const raw = await fs.readFile(storePath, "utf-8");
    expect(raw).not.toContain("skill prompt body");
    const parsed = JSON.parse(raw) as Record<string, SessionEntry>;
    const firstRef = parsed["agent:main:test:1"]?.skillsSnapshot
      ?.promptRef as SessionSkillPromptRef;
    const secondRef = parsed["agent:main:test:2"]?.skillsSnapshot
      ?.promptRef as SessionSkillPromptRef;
    expect(firstRef).toMatchObject({
      version: 1,
      algorithm: "sha256",
      bytes: Buffer.byteLength(prompt, "utf8"),
    });
    expect(secondRef).toEqual(firstRef);
    expect(parsed["agent:main:test:1"]?.skillsSnapshot?.prompt).toBeUndefined();

    const blobPath = path.join(
      testDir,
      "skills-prompts",
      "sha256",
      firstRef.hash.slice(0, 2),
      `${firstRef.hash}.txt`,
    );
    expect(await fs.readFile(blobPath, "utf-8")).toBe(prompt);
    expect(getSessionSkillPromptRefCacheStatsForTest().entries).toBe(1);
  });

  it("clears cached prompt refs with the session store caches", async () => {
    const prompt = `<available_skills>\n${"clear cache prompt\n".repeat(200)}</available_skills>`;
    await saveSessionStore(
      storePath,
      {
        "agent:main:test:1": makeEntry("session-1", makeSnapshotWithPrompt(prompt)),
      },
      { skipMaintenance: true },
    );
    expect(getSessionSkillPromptRefCacheStatsForTest().entries).toBe(1);

    clearSessionStoreCacheForTest();

    expect(getSessionSkillPromptRefCacheStatsForTest().entries).toBe(0);
  });

  it("bounds cached prompt refs for distinct large skills prompts", async () => {
    const entries = Object.fromEntries(
      Array.from({ length: 260 }, (_, index) => {
        const prompt = `<available_skills>\n${`bounded prompt ${index}\n`.repeat(200)}</available_skills>`;
        return [
          `agent:main:test:${index}`,
          makeEntry(`session-${index}`, makeSnapshotWithPrompt(prompt)),
        ];
      }),
    );

    await saveSessionStore(storePath, entries, { skipMaintenance: true });

    const stats = getSessionSkillPromptRefCacheStatsForTest();
    expect(stats.entries).toBe(stats.maxEntries);
  });

  it("hydrates content-addressed skills prompt blobs on load", async () => {
    const prompt = `<available_skills>\n${"persisted prompt\n".repeat(200)}</available_skills>`;
    await saveSessionStore(
      storePath,
      {
        "agent:main:test:1": makeEntry("session-1", makeSnapshotWithPrompt(prompt)),
      },
      { skipMaintenance: true },
    );

    const loaded = loadSessionStore(storePath, { skipCache: true });

    expect(loaded["agent:main:test:1"]?.skillsSnapshot?.prompt).toBe(prompt);
    expect(loaded["agent:main:test:1"]?.skillsSnapshot?.promptRef).toBeUndefined();
    expect(loaded["agent:main:test:1"]?.skillsSnapshot?.resolvedSkills).toBeUndefined();
  });

  it("rewrites a verified prompt blob when cleanup removed it in the same process", async () => {
    const prompt = `<available_skills>\n${"rewritten prompt\n".repeat(200)}</available_skills>`;
    const store = {
      "agent:main:test:1": makeEntry("session-1", makeSnapshotWithPrompt(prompt)),
    };
    await saveSessionStore(storePath, store, { skipMaintenance: true });
    const raw = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, SessionEntry>;
    const hash = raw["agent:main:test:1"]?.skillsSnapshot?.promptRef?.hash;
    if (!hash) {
      throw new Error("expected prompt ref");
    }
    const blobPath = path.join(
      testDir,
      "skills-prompts",
      "sha256",
      hash.slice(0, 2),
      `${hash}.txt`,
    );
    await fs.rm(blobPath);

    await saveSessionStore(storePath, store, { skipMaintenance: true });

    expect(await fs.readFile(blobPath, "utf-8")).toBe(prompt);
  });

  it("refreshes reused prompt blob mtimes before committing prompt refs", async () => {
    const prompt = `<available_skills>\n${"refreshed prompt\n".repeat(200)}</available_skills>`;
    const store = {
      "agent:main:test:1": makeEntry("session-1", makeSnapshotWithPrompt(prompt)),
    };
    await saveSessionStore(storePath, store, { skipMaintenance: true });
    const raw = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, SessionEntry>;
    const hash = raw["agent:main:test:1"]?.skillsSnapshot?.promptRef?.hash;
    if (!hash) {
      throw new Error("expected prompt ref");
    }
    const blobPath = path.join(
      testDir,
      "skills-prompts",
      "sha256",
      hash.slice(0, 2),
      `${hash}.txt`,
    );
    const oldTime = new Date(Date.now() - 10 * 60 * 1000);
    await fs.utimes(blobPath, oldTime, oldTime);

    await saveSessionStore(storePath, store, { skipMaintenance: true });

    const refreshed = await fs.stat(blobPath);
    expect(refreshed.mtimeMs).toBeGreaterThan(oldTime.getTime());
    expect(await fs.readFile(blobPath, "utf-8")).toBe(prompt);
  });

  it("caches validated prompt blobs but still notices deletion", async () => {
    const prompt = `<available_skills>\n${"cached prompt\n".repeat(200)}</available_skills>`;
    await saveSessionStore(
      storePath,
      {
        "agent:main:test:1": makeEntry("session-1", makeSnapshotWithPrompt(prompt)),
      },
      { skipMaintenance: true },
    );
    const raw = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, SessionEntry>;
    const ref = raw["agent:main:test:1"]?.skillsSnapshot?.promptRef;
    if (!ref) {
      throw new Error("expected prompt ref");
    }

    clearSessionStoreCacheForTest();

    expect(getValidSessionSkillPromptBlobCacheStatsForTest().entries).toBe(0);
    expect(isSessionSkillPromptBlobReadable(storePath, ref)).toBe(true);
    expect(getValidSessionSkillPromptBlobCacheStatsForTest().entries).toBe(1);
    expect(isSessionSkillPromptBlobReadable(storePath, ref)).toBe(true);
    expect(getValidSessionSkillPromptBlobCacheStatsForTest().entries).toBe(1);

    const blobPath = path.join(
      testDir,
      "skills-prompts",
      "sha256",
      ref.hash.slice(0, 2),
      `${ref.hash}.txt`,
    );
    await fs.rm(blobPath);

    expect(isSessionSkillPromptBlobReadable(storePath, ref)).toBe(false);
    expect(getValidSessionSkillPromptBlobCacheStatsForTest().entries).toBe(0);
  });

  it("rewrites prompt blobs when the session dir is recreated before store commit", async () => {
    const prompt = `<available_skills>\n${"recreated dir prompt\n".repeat(200)}</available_skills>`;
    const store = {
      "agent:main:test:1": makeEntry("session-1", makeSnapshotWithPrompt(prompt)),
    };
    const realMkdir = fs.mkdir.bind(fs);
    let storeDirMkdirs = 0;
    const mkdirSpy = vi
      .spyOn(fs, "mkdir")
      .mockImplementation(
        async (dirPath: PathLike, options?: MakeDirectoryOptions | Mode | null) => {
          if (typeof dirPath === "string" && path.resolve(dirPath) === path.resolve(testDir)) {
            storeDirMkdirs += 1;
            if (storeDirMkdirs === 2) {
              await fs.rm(testDir, { recursive: true, force: true });
            }
          }
          return await realMkdir(dirPath, options ?? undefined);
        },
      );

    try {
      await saveSessionStore(storePath, store, { skipMaintenance: true });
    } finally {
      mkdirSpy.mockRestore();
    }

    expect(storeDirMkdirs).toBeGreaterThanOrEqual(2);
    const raw = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, SessionEntry>;
    const hash = raw["agent:main:test:1"]?.skillsSnapshot?.promptRef?.hash;
    if (!hash) {
      throw new Error("expected prompt ref");
    }
    const blobPath = path.join(
      testDir,
      "skills-prompts",
      "sha256",
      hash.slice(0, 2),
      `${hash}.txt`,
    );
    expect(await fs.readFile(blobPath, "utf-8")).toBe(prompt);
    expect(
      loadSessionStore(storePath, { skipCache: true })["agent:main:test:1"]?.skillsSnapshot?.prompt,
    ).toBe(prompt);
  });

  it("keeps cache clones hydrated when disk JSON uses prompt refs", async () => {
    process.env.OPENCLAW_SESSION_CACHE_TTL_MS = "45000";
    clearSessionStoreCacheForTest();
    const prompt = `<available_skills>\n${"cached prompt\n".repeat(200)}</available_skills>`;
    await saveSessionStore(
      storePath,
      {
        "agent:main:test:1": makeEntry("session-1", makeSnapshotWithPrompt(prompt)),
      },
      { skipMaintenance: true },
    );

    const loaded = loadSessionStore(storePath);

    expect(loaded["agent:main:test:1"]?.skillsSnapshot?.prompt).toBe(prompt);
    expect(loaded["agent:main:test:1"]?.skillsSnapshot?.promptRef).toBeUndefined();
  });

  it("can skip prompt ref hydration for metadata-only reads", async () => {
    const prompt = `<available_skills>\n${"metadata-only prompt\n".repeat(200)}</available_skills>`;
    await saveSessionStore(
      storePath,
      {
        "agent:main:test:1": makeEntry("session-1", makeSnapshotWithPrompt(prompt)),
      },
      { skipMaintenance: true },
    );

    const loaded = loadSessionStore(storePath, {
      hydrateSkillPromptRefs: false,
      skipCache: true,
    });
    const snapshot = loaded["agent:main:test:1"]?.skillsSnapshot;

    expect(snapshot?.prompt).toBeUndefined();
    expect(snapshot?.promptRef?.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not cache unhydrated prompt refs for later full reads", async () => {
    process.env.OPENCLAW_SESSION_CACHE_TTL_MS = "45000";
    clearSessionStoreCacheForTest();
    const prompt = `<available_skills>\n${"cache-safe prompt\n".repeat(200)}</available_skills>`;
    await saveSessionStore(
      storePath,
      {
        "agent:main:test:1": makeEntry("session-1", makeSnapshotWithPrompt(prompt)),
      },
      { skipMaintenance: true },
    );
    clearSessionStoreCacheForTest();

    const metadataOnly = loadSessionStore(storePath, {
      hydrateSkillPromptRefs: false,
    });
    const fullRead = loadSessionStore(storePath);

    expect(metadataOnly["agent:main:test:1"]?.skillsSnapshot?.prompt).toBeUndefined();
    expect(fullRead["agent:main:test:1"]?.skillsSnapshot?.prompt).toBe(prompt);
    expect(fullRead["agent:main:test:1"]?.skillsSnapshot?.promptRef).toBeUndefined();
  });

  it("keeps small skills prompts inline", async () => {
    const prompt = "short prompt";
    await saveSessionStore(
      storePath,
      {
        "agent:main:test:1": makeEntry("session-1", makeSnapshotWithPrompt(prompt)),
      },
      { skipMaintenance: true },
    );

    const raw = await fs.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, SessionEntry>;

    expect(parsed["agent:main:test:1"]?.skillsSnapshot?.prompt).toBe(prompt);
    expect(parsed["agent:main:test:1"]?.skillsSnapshot?.promptRef).toBeUndefined();
  });

  it("drops stale prompt refs so missing blobs rebuild on the next turn", async () => {
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:main:test:1": {
            sessionId: "session-1",
            updatedAt: Date.now(),
            skillsSnapshot: {
              promptRef: {
                version: 1,
                algorithm: "sha256",
                hash: "a".repeat(64),
                bytes: 123,
              },
              skills: [{ name: "demo" }],
              version: 1,
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const loaded = loadSessionStore(storePath, { skipCache: true });

    expect(loaded["agent:main:test:1"]?.skillsSnapshot).toBeUndefined();
  });
});
