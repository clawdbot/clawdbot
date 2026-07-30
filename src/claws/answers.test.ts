import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readClawAnswersDocument } from "./answers.js";
import { MAX_CLAW_SETUP_ANSWER_BYTES } from "./source-limits.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("readClawAnswersDocument", () => {
  it("reads a bounded local JSON object", async () => {
    const path = join(tempDirs.make("openclaw-claw-answers-"), "answers.json");
    await writeFile(path, JSON.stringify({ timezone: "UTC", enabled: true }), "utf8");

    await expect(readClawAnswersDocument(path)).resolves.toEqual({
      timezone: "UTC",
      enabled: true,
    });
  });

  it("reads stdin and rejects non-object or oversized values", async () => {
    await expect(
      readClawAnswersDocument("-", Readable.from([Buffer.from('{"timezone":"UTC"}')])),
    ).resolves.toEqual({ timezone: "UTC" });
    await expect(readClawAnswersDocument("-", Readable.from(["[]"]))).rejects.toMatchObject({
      code: "setup_answers_invalid",
    });
    await expect(
      readClawAnswersDocument("-", Readable.from([Buffer.alloc(MAX_CLAW_SETUP_ANSWER_BYTES + 1)])),
    ).rejects.toMatchObject({ code: "setup_answers_too_large" });
  });
});
