import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storeSessionLearning } from "./feedback-reflection-store.js";
import {
  buildFeedbackEvent,
  buildReflectionPrompt,
  clearReflectionCooldowns,
  isReflectionAllowed,
  loadSessionLearnings,
  parseReflectionResponse,
  recordReflectionTime,
} from "./feedback-reflection.js";

describe("buildFeedbackEvent", () => {
  it("builds a well-formed custom event", () => {
    const event = buildFeedbackEvent({
      messageId: "msg-123",
      value: "negative",
      comment: "too verbose",
      sessionKey: "msteams:user1",
      agentId: "default",
      conversationId: "19:abc",
    });

    expect(event.type).toBe("custom");
    expect(event.event).toBe("feedback");
    expect(event.value).toBe("negative");
    expect(event.comment).toBe("too verbose");
    expect(event.messageId).toBe("msg-123");
    expect(event.ts).toBeGreaterThan(0);
  });

  it("omits comment when not provided", () => {
    const event = buildFeedbackEvent({
      messageId: "msg-123",
      value: "positive",
      sessionKey: "msteams:user1",
      agentId: "default",
      conversationId: "19:abc",
    });

    expect(event.comment).toBeUndefined();
    expect(event.value).toBe("positive");
  });
});

describe("buildReflectionPrompt", () => {
  it("includes the thumbed-down response", () => {
    const prompt = buildReflectionPrompt({
      thumbedDownResponse: "Here is a long explanation...",
    });

    expect(prompt).toContain("previous response wasn't helpful");
    expect(prompt).toContain("Here is a long explanation...");
    expect(prompt).toContain("reflect");
  });

  it("truncates long responses", () => {
    const longResponse = "x".repeat(600);
    const prompt = buildReflectionPrompt({
      thumbedDownResponse: longResponse,
    });

    expect(prompt).toContain("...");
    expect(prompt.length).toBeLessThan(longResponse.length + 500);
  });

  it("includes user comment when provided", () => {
    const prompt = buildReflectionPrompt({
      thumbedDownResponse: "Some response",
      userComment: "Too wordy",
    });

    expect(prompt).toContain('User\'s comment: "Too wordy"');
  });

  it("works without optional params", () => {
    const prompt = buildReflectionPrompt({});
    expect(prompt).toContain("previous response wasn't helpful");
    expect(prompt).toContain('"followUp":false');
  });
});

describe("parseReflectionResponse", () => {
  it("parses strict JSON output", () => {
    expect(
      parseReflectionResponse(
        '{"learning":"Be more direct next time.","followUp":true,"userMessage":"Sorry about that. I will keep it tighter."}',
      ),
    ).toEqual({
      learning: "Be more direct next time.",
      followUp: true,
      userMessage: "Sorry about that. I will keep it tighter.",
    });
  });

  it("parses JSON inside markdown fences", () => {
    expect(
      parseReflectionResponse(
        '```json\n{"learning":"Ask a clarifying question first.","followUp":false,"userMessage":""}\n```',
      ),
    ).toEqual({
      learning: "Ask a clarifying question first.",
      followUp: false,
      userMessage: undefined,
    });
  });

  it("falls back to internal-only learning when parsing fails", () => {
    expect(parseReflectionResponse("Be more concise.\nFollow up: yes.")).toEqual({
      learning: "Be more concise.\nFollow up: yes.",
      followUp: false,
    });
  });
});

describe("reflection cooldown", () => {
  afterEach(() => {
    clearReflectionCooldowns();
    vi.restoreAllMocks();
  });

  it("allows first reflection", () => {
    expect(isReflectionAllowed("session-1")).toBe(true);
  });

  it("blocks reflection within cooldown", () => {
    recordReflectionTime("session-1");
    expect(isReflectionAllowed("session-1", 60_000)).toBe(false);
  });

  it("allows reflection after cooldown expires", () => {
    // Manually set a past timestamp
    recordReflectionTime("session-1");
    // Override the map entry to simulate time passing
    clearReflectionCooldowns();
    expect(isReflectionAllowed("session-1", 1)).toBe(true);
  });

  it("tracks sessions independently", () => {
    recordReflectionTime("session-1");
    expect(isReflectionAllowed("session-1", 60_000)).toBe(false);
    expect(isReflectionAllowed("session-2", 60_000)).toBe(true);
  });

  it("keeps longer custom cooldown entries during pruning", () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    recordReflectionTime("target", 600_000);

    vi.spyOn(Date, "now").mockReturnValue(301_000);
    for (let index = 0; index <= 500; index += 1) {
      recordReflectionTime(`session-${index}`, 600_000);
    }

    expect(isReflectionAllowed("target", 600_000)).toBe(false);
  });
});

describe("loadSessionLearnings", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty array when file doesn't exist", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "learnings-test-"));
    const learnings = await loadSessionLearnings(tmpDir, "nonexistent");
    expect(learnings).toStrictEqual([]);
  });

  it("reads existing learnings", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "learnings-test-"));
    const safeKey = Buffer.from("msteams:user1", "utf8").toString("base64url");
    const filePath = path.join(tmpDir, `${safeKey}.learnings.json`);
    await writeFile(filePath, JSON.stringify(["Be concise", "Use examples"]), "utf-8");

    const learnings = await loadSessionLearnings(tmpDir, "msteams:user1");
    expect(learnings).toEqual(["Be concise", "Use examples"]);
  });

  it("keeps distinct session keys isolated across the filename persistence boundary", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "learnings-test-"));

    await storeSessionLearning({
      storePath: tmpDir,
      sessionKey: "msteams:user1",
      learning: "Use bullets",
    });
    await storeSessionLearning({
      storePath: tmpDir,
      sessionKey: "msteams/user1",
      learning: "Avoid bullets",
    });

    await expect(loadSessionLearnings(tmpDir, "msteams:user1")).resolves.toEqual(["Use bullets"]);
    await expect(loadSessionLearnings(tmpDir, "msteams/user1")).resolves.toEqual(["Avoid bullets"]);
  });

  it("reads and migrates legacy sanitized session learning files", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "learnings-test-"));
    const legacyFile = path.join(tmpDir, "msteams_user1.learnings.json");
    await writeFile(legacyFile, JSON.stringify(["Legacy learning"]), "utf-8");

    await expect(loadSessionLearnings(tmpDir, "msteams:user1")).resolves.toEqual([
      "Legacy learning",
    ]);

    await storeSessionLearning({
      storePath: tmpDir,
      sessionKey: "msteams:user1",
      learning: "New learning",
    });

    const migratedFile = path.join(
      tmpDir,
      `${Buffer.from("msteams:user1", "utf8").toString("base64url")}.learnings.json`,
    );
    await expect(loadSessionLearnings(tmpDir, "msteams:user1")).resolves.toEqual([
      "Legacy learning",
      "New learning",
    ]);
    await expect(rm(legacyFile, { force: false })).rejects.toHaveProperty("code", "ENOENT");
    await expect(loadSessionLearnings(tmpDir, "msteams:user1")).resolves.toEqual([
      "Legacy learning",
      "New learning",
    ]);
    await expect(loadSessionLearnings(tmpDir, "msteams/user1")).resolves.toStrictEqual([]);
    await expect(
      import("node:fs/promises").then((fs) => fs.readFile(migratedFile, "utf-8")),
    ).resolves.toContain("Legacy learning");
  });
});
