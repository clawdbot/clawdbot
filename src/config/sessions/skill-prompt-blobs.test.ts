import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  ensureSessionStorePromptBlobsForPersistence,
  hydrateSessionStoreSkillPromptRefs,
  projectSessionStoreForPersistence,
} from "./skill-prompt-blobs.js";
import type { SessionEntry } from "./types.js";

function largePrompt(label: string): string {
  return `<available_skills>\n${`${label}\n`.repeat(200)}</available_skills>`;
}

describe("session skill prompt blobs", () => {
  it("externalizes and hydrates the persisted prompt byte-exactly", async () => {
    await withTempDir({ prefix: "openclaw-skill-prompt-blobs-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const prompt = largePrompt("catalog");
      const projection = projectSessionStoreForPersistence({
        storePath,
        store: {
          session: {
            sessionId: "session",
            updatedAt: 1,
            skillsSnapshot: {
              prompt,
              promptFormatVersion: 4,
              skills: [{ name: "demo" }],
            },
          },
        },
      });

      const persistedSnapshot = projection.store.session?.skillsSnapshot;
      expect(persistedSnapshot?.prompt).toBeUndefined();
      expect(persistedSnapshot?.promptRef).toBeDefined();
      expect(projection.promptBlobs.size).toBe(1);

      await ensureSessionStorePromptBlobsForPersistence({
        storePath,
        promptBlobs: projection.promptBlobs.values(),
      });
      const hydratedStore: Record<string, unknown> = { ...projection.store };
      expect(hydrateSessionStoreSkillPromptRefs({ storePath, store: hydratedStore })).toBe(true);
      const hydrated = (hydratedStore.session as SessionEntry).skillsSnapshot;
      expect(hydrated?.prompt).toBe(prompt);
      expect(hydrated?.promptRef).toBeUndefined();
    });
  });

  it("drops the snapshot when its referenced prompt blob is missing", async () => {
    await withTempDir({ prefix: "openclaw-skill-prompt-blobs-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const projection = projectSessionStoreForPersistence({
        storePath,
        store: {
          session: {
            sessionId: "session",
            updatedAt: 1,
            skillsSnapshot: {
              prompt: largePrompt("catalog"),
              promptFormatVersion: 4,
              skills: [{ name: "demo" }],
            },
          },
        },
      });
      await ensureSessionStorePromptBlobsForPersistence({
        storePath,
        promptBlobs: projection.promptBlobs.values(),
      });
      const promptHash = projection.store.session?.skillsSnapshot?.promptRef?.hash;
      if (!promptHash) {
        throw new Error("expected prompt ref");
      }
      await fs.rm(
        path.join(dir, "skills-prompts", "sha256", promptHash.slice(0, 2), `${promptHash}.txt`),
      );

      const hydratedStore: Record<string, unknown> = { ...projection.store };
      expect(hydrateSessionStoreSkillPromptRefs({ storePath, store: hydratedStore })).toBe(true);
      expect((hydratedStore.session as SessionEntry).skillsSnapshot).toBeUndefined();
    });
  });
});
