import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  emitDiagnosticsTimelineEvent,
  flushDiagnosticsTimelineForTest,
  isDiagnosticsTimelineEnabled,
  measureDiagnosticsTimelineSpan,
  measureDiagnosticsTimelineSpanSync,
} from "./diagnostics-timeline.js";

const tempDirs: string[] = [];

async function createTimelineEnv() {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-diagnostics-timeline-"));
  tempDirs.push(dir);
  return {
    env: {
      OPENCLAW_DIAGNOSTICS: "timeline",
      OPENCLAW_DIAGNOSTICS_RUN_ID: "run-1",
      OPENCLAW_DIAGNOSTICS_ENV: "env-1",
      OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: join(dir, "nested", "timeline.jsonl"),
    } as NodeJS.ProcessEnv,
    path: join(dir, "nested", "timeline.jsonl"),
  };
}

async function readTimeline(path: string) {
  await flushDiagnosticsTimelineForTest();
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function eventRecord(events: Record<string, unknown>[], index: number): Record<string, unknown> {
  const event = events[index];
  if (!event) {
    throw new Error(`Expected diagnostics event at index ${index}`);
  }
  return event;
}

function attributesRecord(event: Record<string, unknown>): Record<string, unknown> {
  if (
    !event.attributes ||
    typeof event.attributes !== "object" ||
    Array.isArray(event.attributes)
  ) {
    throw new Error("Expected diagnostics event attributes");
  }
  return event.attributes as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("diagnostics timeline", () => {
  it("detects when timeline output is enabled", async () => {
    const { env } = await createTimelineEnv();

    expect(isDiagnosticsTimelineEnabled({ env })).toBe(true);
    expect(isDiagnosticsTimelineEnabled({ env: { ...env, OPENCLAW_DIAGNOSTICS: "1" } })).toBe(true);
    expect(isDiagnosticsTimelineEnabled({ env: { ...env, OPENCLAW_DIAGNOSTICS: "yes" } })).toBe(
      true,
    );
    expect(isDiagnosticsTimelineEnabled({ env: { ...env, OPENCLAW_DIAGNOSTICS: "on" } })).toBe(
      true,
    );
    expect(isDiagnosticsTimelineEnabled({ env: { ...env, OPENCLAW_DIAGNOSTICS: "all" } })).toBe(
      true,
    );
    expect(isDiagnosticsTimelineEnabled({ env: { ...env, OPENCLAW_DIAGNOSTICS: "*" } })).toBe(true);
    expect(
      isDiagnosticsTimelineEnabled({
        env: { ...env, OPENCLAW_DIAGNOSTICS: "diagnostics.timeline" },
      }),
    ).toBe(true);
    expect(
      isDiagnosticsTimelineEnabled({ env: { ...env, OPENCLAW_DIAGNOSTICS: "telegram.http" } }),
    ).toBe(false);
    expect(isDiagnosticsTimelineEnabled({ env: { ...env, OPENCLAW_DIAGNOSTICS: "0" } })).toBe(
      false,
    );
    expect(
      isDiagnosticsTimelineEnabled({
        env: { ...env, OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: "" },
      }),
    ).toBe(false);
  });

  it("honors config diagnostics flags after config is available", async () => {
    const { env } = await createTimelineEnv();
    const envWithoutFlag = { ...env };
    delete envWithoutFlag.OPENCLAW_DIAGNOSTICS;
    const configWithTimeline = { diagnostics: { flags: ["timeline"] } } as OpenClawConfig;
    const configWithWildcard = { diagnostics: { flags: ["*"] } } as OpenClawConfig;
    const configWithoutTimeline = { diagnostics: { flags: ["telegram.http"] } } as OpenClawConfig;

    expect(isDiagnosticsTimelineEnabled({ config: configWithTimeline, env: envWithoutFlag })).toBe(
      true,
    );
    expect(isDiagnosticsTimelineEnabled({ config: configWithWildcard, env: envWithoutFlag })).toBe(
      true,
    );
    expect(
      isDiagnosticsTimelineEnabled({ config: configWithoutTimeline, env: envWithoutFlag }),
    ).toBe(false);
  });

  it("lets false-like env diagnostics disable config-enabled timeline output", async () => {
    const { env } = await createTimelineEnv();
    const configWithTimeline = { diagnostics: { flags: ["timeline"] } } as OpenClawConfig;

    expect(
      isDiagnosticsTimelineEnabled({
        config: configWithTimeline,
        env: { ...env, OPENCLAW_DIAGNOSTICS: "0" },
      }),
    ).toBe(false);
  });

  it("writes JSONL diagnostic events with the stable envelope", async () => {
    const { env, path } = await createTimelineEnv();

    emitDiagnosticsTimelineEvent(
      {
        type: "mark",
        name: "gateway.ready",
        phase: "startup",
        attributes: {
          ok: true,
          count: 2,
          ignored: Number.NaN,
        },
      },
      { env },
    );

    const [event] = await readTimeline(path);
    expect(event?.schemaVersion).toBe("openclaw.diagnostics.v1");
    expect(event?.type).toBe("mark");
    expect(event?.name).toBe("gateway.ready");
    expect(event?.runId).toBe("run-1");
    expect(event?.envName).toBe("env-1");
    expect(event?.phase).toBe("startup");
    const attributes = attributesRecord(event ?? {});
    expect(attributes.ok).toBe(true);
    expect(attributes.count).toBe(2);
    expect(event?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    expect(event?.pid).toBe(process.pid);
    expect(attributes.ignored).toBeUndefined();
  });

  it("records span start and end events around successful work", async () => {
    const { env, path } = await createTimelineEnv();
    const configOnlyEnv = { ...env };
    delete configOnlyEnv.OPENCLAW_DIAGNOSTICS;

    await expect(
      measureDiagnosticsTimelineSpan("runtimeDeps.stage", () => "ok", {
        phase: "startup",
        attributes: { pluginCount: 3 },
        config: { diagnostics: { flags: ["timeline"] } } as OpenClawConfig,
        env: configOnlyEnv,
      }),
    ).resolves.toBe("ok");

    const events = await readTimeline(path);
    expect(events).toHaveLength(2);
    const start = eventRecord(events, 0);
    const end = eventRecord(events, 1);
    expect(start.type).toBe("span.start");
    expect(start.name).toBe("runtimeDeps.stage");
    expect(start.phase).toBe("startup");
    expect(attributesRecord(start).pluginCount).toBe(3);
    expect(end.type).toBe("span.end");
    expect(end.name).toBe("runtimeDeps.stage");
    expect(end.phase).toBe("startup");
    expect(attributesRecord(end).pluginCount).toBe(3);
    expect(end.spanId).toBe(start.spanId);
    expect(end.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records span error events and rethrows failures", async () => {
    const { env, path } = await createTimelineEnv();

    await expect(
      measureDiagnosticsTimelineSpan(
        "plugins.load",
        () => {
          throw new TypeError("bad plugin");
        },
        { env, phase: "startup" },
      ),
    ).rejects.toThrow("bad plugin");

    const events = await readTimeline(path);
    expect(events).toHaveLength(2);
    const errorEvent = eventRecord(events, 1);
    expect(errorEvent.type).toBe("span.error");
    expect(errorEvent.name).toBe("plugins.load");
    expect(errorEvent.phase).toBe("startup");
    expect(errorEvent.errorName).toBe("TypeError");
    expect(errorEvent.errorMessage).toBe("bad plugin");
  });

  it("records synchronous spans", async () => {
    const { env, path } = await createTimelineEnv();

    const result = measureDiagnosticsTimelineSpanSync("plugins.metadata.scan", () => 42, {
      env,
      phase: "startup",
    });

    expect(result).toBe(42);
    const events = await readTimeline(path);
    expect(events).toHaveLength(2);
    const start = eventRecord(events, 0);
    const end = eventRecord(events, 1);
    expect(start.type).toBe("span.start");
    expect(start.name).toBe("plugins.metadata.scan");
    expect(end.type).toBe("span.end");
    expect(end.name).toBe("plugins.metadata.scan");
  });

  it("lets nested spans inherit the active timeline phase and parent span", async () => {
    const { env, path } = await createTimelineEnv();

    const result = await measureDiagnosticsTimelineSpan(
      "reply.run_agent_turn",
      () =>
        measureDiagnosticsTimelineSpanSync("plugins.metadata.scan", () => 42, {
          env,
        }),
      {
        env,
        phase: "agent-turn",
      },
    );

    expect(result).toBe(42);
    const events = await readTimeline(path);
    expect(events).toHaveLength(4);
    const [parentStart, childStart, childEnd, parentEnd] = events;
    expect(parentStart?.type).toBe("span.start");
    expect(parentStart?.name).toBe("reply.run_agent_turn");
    expect(parentStart?.phase).toBe("agent-turn");
    expect(childStart?.type).toBe("span.start");
    expect(childStart?.name).toBe("plugins.metadata.scan");
    expect(childStart?.phase).toBe("agent-turn");
    expect(childStart?.parentSpanId).toBe(parentStart?.spanId);
    expect(childEnd?.type).toBe("span.end");
    expect(childEnd?.name).toBe("plugins.metadata.scan");
    expect(childEnd?.phase).toBe("agent-turn");
    expect(childEnd?.parentSpanId).toBe(parentStart?.spanId);
    expect(parentEnd?.type).toBe("span.end");
    expect(parentEnd?.name).toBe("reply.run_agent_turn");
    expect(parentEnd?.phase).toBe("agent-turn");
  });
});
