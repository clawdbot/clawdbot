import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  measureEmbeddedAgentPreparation,
  measureEmbeddedAgentPreparationSync,
} from "./preparation-timing.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createTimelineEnv() {
  const dir = tempDirs.make("openclaw-agent-preparation-");
  return {
    env: {
      OPENCLAW_DIAGNOSTICS: "timeline",
      OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: join(dir, "timeline.jsonl"),
    } as NodeJS.ProcessEnv,
    path: join(dir, "timeline.jsonl"),
  };
}

async function readTimeline(path: string) {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("embedded agent preparation timing", () => {
  it("emits the canonical span name with stage attribution", async () => {
    const { env, path } = await createTimelineEnv();

    await measureEmbeddedAgentPreparation("runtime", async () => "async", { env });
    expect(measureEmbeddedAgentPreparationSync("attempt.tool-base", () => "sync", { env })).toBe(
      "sync",
    );

    const events = await readTimeline(path);
    expect(events.map((event) => event.name)).toEqual([
      "agent.prepare",
      "agent.prepare",
      "agent.prepare",
      "agent.prepare",
    ]);
    expect(events.map((event) => event.phase)).toEqual([
      "agent.prepare",
      "agent.prepare",
      "agent.prepare",
      "agent.prepare",
    ]);
    expect(events.map((event) => event.attributes)).toEqual([
      { stage: "runtime" },
      { stage: "runtime" },
      { stage: "attempt.tool-base" },
      { stage: "attempt.tool-base" },
    ]);
  });
});
