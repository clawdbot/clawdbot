import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveMediaBufferPath, saveMediaBuffer, type SavedMedia } from "../../media/store.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { persistGeneratedMediaBatch } from "./generated-media-batch-persistence.js";

const GENERATED_MEDIA_SUBDIR = "generated";

async function expectSavedMediaMissing(saved: SavedMedia): Promise<void> {
  await expect(resolveMediaBufferPath(saved.id, GENERATED_MEDIA_SUBDIR)).rejects.toThrow(
    "media ID does not resolve to a file",
  );
}

describe("persistGeneratedMediaBatch filesystem rollback", () => {
  it("removes a real file when a later sequential save fails", async () => {
    await withTempDir({ prefix: "openclaw-generated-media-batch-" }, async (stateDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const payload = Buffer.from("persisted before failure");
        let saved: SavedMedia | undefined;
        const failure = new Error("later save failed");

        await expect(
          persistGeneratedMediaBatch({
            subdir: GENERATED_MEDIA_SUBDIR,
            mode: "sequential",
            saves: [
              async () => {
                saved = await saveMediaBuffer(payload, "text/plain", GENERATED_MEDIA_SUBDIR);
                const savedPath = await resolveMediaBufferPath(saved.id, GENERATED_MEDIA_SUBDIR);
                await expect(fs.readFile(savedPath)).resolves.toEqual(payload);
                return { value: savedPath, savedMedia: saved };
              },
              async () => {
                throw failure;
              },
            ],
          }),
        ).rejects.toBe(failure);

        expect(saved).toBeDefined();
        await expectSavedMediaMissing(saved!);
      });
    });
  });

  it("drains and removes a real concurrent write that finishes after failure", async () => {
    await withTempDir({ prefix: "openclaw-generated-media-batch-" }, async (stateDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const releaseLateSave = createDeferred();
        const payload = Buffer.from("persisted after failure");
        let saved: SavedMedia | undefined;
        const failure = new Error("concurrent save failed");

        await expect(
          persistGeneratedMediaBatch({
            subdir: GENERATED_MEDIA_SUBDIR,
            mode: "concurrent",
            saves: [
              async () => {
                await releaseLateSave.promise;
                saved = await saveMediaBuffer(payload, "text/plain", GENERATED_MEDIA_SUBDIR);
                const savedPath = await resolveMediaBufferPath(saved.id, GENERATED_MEDIA_SUBDIR);
                await expect(fs.readFile(savedPath)).resolves.toEqual(payload);
                return { value: savedPath, savedMedia: saved };
              },
              async () => {
                releaseLateSave.resolve();
                throw failure;
              },
            ],
          }),
        ).rejects.toBe(failure);

        expect(saved).toBeDefined();
        await expectSavedMediaMissing(saved!);
      });
    });
  });
});
