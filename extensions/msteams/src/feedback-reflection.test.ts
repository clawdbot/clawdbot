import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { setMSTeamsRuntime } from "./runtime.js";
import { msteamsRuntimeStub } from "./test-support/runtime.js";

const previousStateDir = process.env.OPENCLAW_STATE_DIR;

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

  beforeEach(() => {
    resetPluginStateStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
  });

  afterEach(async () => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty array when file doesn't exist", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "learnings-test-"));
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const learnings = await loadSessionLearnings(tmpDir, "nonexistent");
    expect(learnings).toStrictEqual([]);
  });

  it("reads persisted learnings from plugin state", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "learnings-test-"));
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    await storeSessionLearning({
      storePath: tmpDir,
      sessionKey: "msteams:user1",
      learning: "Be concise",
    });
    await storeSessionLearning({
      storePath: tmpDir,
      sessionKey: "msteams:user1",
      learning: "Use examples",
    });

    const learnings = await loadSessionLearnings(tmpDir, "msteams:user1");
    expect(learnings).toEqual(["Be concise", "Use examples"]);
  });

  it("keeps distinct session keys isolated across the filename persistence boundary", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "learnings-test-"));
    process.env.OPENCLAW_STATE_DIR = tmpDir;

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

  it("keeps the same session key isolated by store path", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "learnings-test-"));
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const workStorePath = path.join(tmpDir, "work");
    const opsStorePath = path.join(tmpDir, "ops");

    await storeSessionLearning({
      storePath: workStorePath,
      sessionKey: "msteams:user1",
      learning: "Use bullets",
    });
    await storeSessionLearning({
      storePath: opsStorePath,
      sessionKey: "msteams:user1",
      learning: "Avoid bullets",
    });

    await expect(loadSessionLearnings(workStorePath, "msteams:user1")).resolves.toEqual([
      "Use bullets",
    ]);
    await expect(loadSessionLearnings(opsStorePath, "msteams:user1")).resolves.toEqual([
      "Avoid bullets",
    ]);
  });
});
