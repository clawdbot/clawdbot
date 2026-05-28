import type { MakeDirectoryOptions, Mode, PathLike } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEmbeddedRunSkillEntries } from "../../agents/embedded-agent-runner/skills-runtime.js";
import { createCanonicalFixtureSkill } from "../../agents/skills.test-helpers.js";
import type { Skill } from "../../agents/skills/skill-contract.js";
import {
  hydrateResolvedSkills,
  hydrateResolvedSkillsAsync,
} from "../../agents/skills/snapshot-hydration.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import type { SessionEntry, SessionSkillPromptRef, SessionSkillSnapshot } from "./types.js";

vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

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

describe("embedded runner falls back to disk when resolvedSkills is absent", () => {
  it("signals shouldLoadSkillEntries when the persisted snapshot has no resolvedSkills", () => {
    const result = resolveEmbeddedRunSkillEntries({
      workspaceDir: "/nonexistent-workspace-for-test",
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "x" }],
        version: 1,
        // resolvedSkills intentionally omitted — this is the post-fix shape.
      },
    });

    expect(result.shouldLoadSkillEntries).toBe(true);
  });

  it("skips loading when resolvedSkills is present (in-turn cache hot path)", () => {
    const result = resolveEmbeddedRunSkillEntries({
      workspaceDir: "/nonexistent-workspace-for-test",
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "x" }],
        resolvedSkills: [makeFixtureSkill("x", 100)],
        version: 1,
      },
    });

    expect(result.shouldLoadSkillEntries).toBe(false);
    expect(result.skillEntries).toStrictEqual([]);
  });
});

describe("hydrateResolvedSkills", () => {
  it("returns the same snapshot when resolvedSkills is already populated", () => {
    const snapshot: SessionSkillSnapshot = {
      prompt: "p",
      skills: [{ name: "x" }],
      resolvedSkills: [makeFixtureSkill("x", 100)],
      version: 1,
    };
    let buildCalls = 0;
    const result = hydrateResolvedSkills(snapshot, () => {
      buildCalls += 1;
      return { prompt: "rebuilt", skills: [], resolvedSkills: [], version: 99 };
    });
    expect(result).toBe(snapshot);
    expect(buildCalls).toBe(0);
  });

  it("rebuilds resolvedSkills only when missing and preserves persisted fields", () => {
    // Simulates a cold session resume: the on-disk snapshot has no
    // resolvedSkills, but consumers like prepareClaudeCliSkillsPlugin still
    // need them. Hydration must not change prompt/skills/version, so the
    // model's prompt-cache key stays stable across resume.
    const stripped: SessionSkillSnapshot = {
      prompt: "original-prompt",
      skills: [{ name: "x" }],
      skillFilter: ["x"],
      version: 7,
    };
    const rebuiltSkills = [makeFixtureSkill("x", 200)];
    let buildCalls = 0;
    const result = hydrateResolvedSkills(stripped, () => {
      buildCalls += 1;
      return {
        prompt: "DIFFERENT-PROMPT",
        skills: [{ name: "y" }],
        resolvedSkills: rebuiltSkills,
        version: 99,
      };
    });
    expect(buildCalls).toBe(1);
    expect(result.prompt).toBe("original-prompt");
    expect(result.skills).toEqual([{ name: "x" }]);
    expect(result.skillFilter).toEqual(["x"]);
    expect(result.version).toBe(7);
    expect(result.resolvedSkills).toBe(rebuiltSkills);
  });

  it("hydrates an empty resolvedSkills array as if it were absent is NOT done — empty is treated as populated", () => {
    // A resolvedSkills set explicitly to [] means the workspace genuinely had
    // no skills, not that the field was stripped. Don't trigger a rebuild.
    const snapshot: SessionSkillSnapshot = {
      prompt: "",
      skills: [],
      resolvedSkills: [],
      version: 1,
    };
    let buildCalls = 0;
    const result = hydrateResolvedSkills(snapshot, () => {
      buildCalls += 1;
      return { prompt: "", skills: [], resolvedSkills: [makeFixtureSkill("x")], version: 1 };
    });
    expect(result).toBe(snapshot);
    expect(buildCalls).toBe(0);
  });

  it("supports async runtime hydration for CLI resume paths", async () => {
    const stripped: SessionSkillSnapshot = {
      prompt: "cached-prompt",
      skills: [{ name: "x" }],
      version: 2,
    };
    const rebuiltSkills = [makeFixtureSkill("x", 120)];
    const result = await hydrateResolvedSkillsAsync(stripped, async () => ({
      prompt: "fresh-prompt",
      skills: [{ name: "y" }],
      resolvedSkills: rebuiltSkills,
      version: 3,
    }));
    expect(result.prompt).toBe("cached-prompt");
    expect(result.skills).toEqual([{ name: "x" }]);
    expect(result.version).toBe(2);
    expect(result.resolvedSkills).toBe(rebuiltSkills);
  });
});
