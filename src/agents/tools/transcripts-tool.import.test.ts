import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { TranscriptsStore } from "../../transcripts/store.js";
import { createTranscriptsTool } from "./transcripts-tool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function currentDateDir(): string {
  return new Date().toISOString().slice(0, 10);
}

function storeFor(stateDir: string): TranscriptsStore {
  return new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
}

function createTool(stateDir: string) {
  return createTranscriptsTool({ config: { transcripts: { enabled: true } }, stateDir });
}

describe("transcripts tool imports", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("imports a speaker transcript and writes summary artifacts", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-");
    const result = await createTool(stateDir).execute(
      "call-1",
      {
        action: "import",
        providerId: "manual-transcript",
        sessionId: "design-review",
        title: "Design review",
        transcript:
          "Alex: We decided to ship Discord first.\nSam: Action item: add Slack import later.",
      },
      undefined,
      vi.fn(),
    );

    expect(result).toMatchObject({
      details: { sessionId: "design-review", utteranceCount: 2 },
    });
    await expect(
      fs.readFile(
        path.join(stateDir, "transcripts", currentDateDir(), "design-review", "summary.md"),
        "utf8",
      ),
    ).resolves.toContain("Sam: Action item: add Slack import later.");
    await expect(
      fs.readFile(
        path.join(stateDir, "transcripts", currentDateDir(), "design-review", "summary.json"),
        "utf8",
      ),
    ).resolves.toContain('"Alex: We decided to ship Discord first."');
    const stored = await storeFor(stateDir).readSession("design-review");
    expect(stored).toBeDefined();
    await expect(storeFor(stateDir).readUtterancesForSession(stored!)).resolves.toEqual([
      expect.objectContaining({ text: "We decided to ship Discord first." }),
      expect.objectContaining({ text: "Action item: add Slack import later." }),
    ]);
  });

  it("bounds summary input while retaining the full transcript", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-");
    const transcript = Array.from(
      { length: 2_001 },
      (_, index) => `Alex: transcript line ${index}`,
    ).join("\n");

    await createTool(stateDir).execute(
      "call-1",
      {
        action: "import",
        providerId: "manual-transcript",
        sessionId: "long-meeting",
        title: "Long meeting",
        transcript,
      },
      undefined,
      vi.fn(),
    );

    const summary = await fs.readFile(
      path.join(stateDir, "transcripts", currentDateDir(), "long-meeting", "summary.md"),
      "utf8",
    );
    expect(summary).not.toContain("transcript line 0\n");
    expect(summary).toContain("transcript line 2000");
    const stored = await storeFor(stateDir).readSession("long-meeting");
    expect(stored).toBeDefined();
    const storedTranscript = await storeFor(stateDir).readUtterancesForSession(stored!);
    expect(storedTranscript[0]?.text).toContain("transcript line 0");
    expect(storedTranscript.at(-1)?.text).toContain("transcript line 2000");
  });

  it("requires date-qualified selectors for repeated stored session ids", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-");
    const store = storeFor(stateDir);
    await store.writeSession({
      sessionId: "standup",
      title: "Tuesday standup",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-05-21T10:00:00.000Z",
    });
    await store.writeSession({
      sessionId: "standup",
      title: "Wednesday standup",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-05-22T10:00:00.000Z",
    });

    await expect(store.readSession("standup")).rejects.toThrow(
      "multiple transcripts sessions match standup",
    );
    await expect(store.readSession("2026-05-21/standup")).resolves.toMatchObject({
      title: "Tuesday standup",
    });
  });
});
