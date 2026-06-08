// Session store skill persistence tests cover SQLite metadata normalization.
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "../../skills/loading/skill-contract.js";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import type { SessionEntry, SessionSkillSnapshot } from "./types.js";

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

describe("session store strips resolvedSkills from SQLite persistence", () => {
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

  it("does not persist resolvedSkills", async () => {
    const store = {
      "agent:main:test:1": makeEntry("session-1", makeSnapshot(5)),
    };

    await saveSessionStore(storePath, store, { skipMaintenance: true });

    const loaded = loadSessionStore(storePath, { skipCache: true });
    const snapshot = loaded["agent:main:test:1"]?.skillsSnapshot;
    expect(snapshot?.resolvedSkills).toBeUndefined();
    expect(snapshot?.skills).toHaveLength(5);
    expect(snapshot?.prompt).toBe("<available_skills>...</available_skills>");
  });

  it("strips resolvedSkills written through updateSessionStore", async () => {
    await updateSessionStore(
      storePath,
      (store) => {
        store["agent:main:test:1"] = makeEntry("session-1", makeSnapshot(6));
      },
      { skipMaintenance: true },
    );

    const loaded = loadSessionStore(storePath, { skipCache: true });
    const snapshot = loaded["agent:main:test:1"]?.skillsSnapshot;
    expect(snapshot?.resolvedSkills).toBeUndefined();
    expect(snapshot?.skills).toHaveLength(6);
  });

  it("roundtrips large skills prompts in SQLite", async () => {
    const prompt = `<available_skills>\n${"skill prompt body\n".repeat(200)}</available_skills>`;
    await saveSessionStore(
      storePath,
      {
        "agent:main:test:1": makeEntry("session-1", makeSnapshotWithPrompt(prompt)),
      },
      { skipMaintenance: true },
    );

    const loaded = loadSessionStore(storePath, { skipCache: true });
    const snapshot = loaded["agent:main:test:1"]?.skillsSnapshot;
    expect(snapshot?.prompt).toBe(prompt);
    expect(snapshot?.promptRef).toBeUndefined();
    expect(snapshot?.resolvedSkills).toBeUndefined();
  });
});
