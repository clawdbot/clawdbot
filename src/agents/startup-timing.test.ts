import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { flushDiagnosticsTimeline } from "../infra/diagnostics-timeline.js";
import { measureAgentStartup } from "./startup-timing.js";

const tempDirs: string[] = [];

afterEach(async () => {
  flushDiagnosticsTimeline();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("measureAgentStartup", () => {
  it("records the startup stage without changing the result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-agent-startup-"));
    tempDirs.push(dir);
    const path = join(dir, "timeline.jsonl");
    const env = {
      OPENCLAW_DIAGNOSTICS: "timeline",
      OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: path,
    } as NodeJS.ProcessEnv;

    await expect(measureAgentStartup("command-import", async () => "ready", { env })).resolves.toBe(
      "ready",
    );

    flushDiagnosticsTimeline();
    const events = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "span.start",
      name: "agent.startup",
      phase: "agent.startup",
      attributes: { stage: "command-import" },
    });
    expect(events[1]).toMatchObject({
      type: "span.end",
      name: "agent.startup",
      phase: "agent.startup",
      attributes: { stage: "command-import" },
    });
  });
});
