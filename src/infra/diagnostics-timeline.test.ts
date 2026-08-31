// Covers diagnostics timeline event writing and spans.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  emitDiagnosticsTimelineEvent,
  flushDiagnosticsTimeline,
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
  flushDiagnosticsTimeline();
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
  flushDiagnosticsTimeline();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("diagnostics timeline", () => {
  it("defers a timeline burst and writes its ordered events in one safe append", async () => {
    const { env, path } = await createTimelineEnv();
    const open = vi.spyOn(fs, "openSync");
    const names = Array.from({ length: 64 }, (_, index) => `event-${index}`);

    for (const name of names) {
      emitDiagnosticsTimelineEvent({ type: "mark", name }, { env });
    }

    expect(open.mock.calls.filter(([file]) => file === path)).toHaveLength(0);
    await yieldToEventLoop();
    expect(open.mock.calls.filter(([file]) => file === path)).toHaveLength(1);
    expect((await readTimeline(path)).map((event) => event.name)).toEqual(names);
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
  });

  it("captures emitted values and flushes earlier paths before switching destinations", async () => {
    const first = await createTimelineEnv();
    const second = await createTimelineEnv();
    const attributes = { value: "before" };
    emitDiagnosticsTimelineEvent({ type: "mark", name: "first", attributes }, { env: first.env });
    attributes.value = "after";
    first.env.OPENCLAW_DIAGNOSTICS_RUN_ID = "changed";
    first.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = second.path;
    emitDiagnosticsTimelineEvent({ type: "mark", name: "second", attributes }, { env: first.env });

    expect(JSON.parse(fs.readFileSync(first.path, "utf8"))).toMatchObject({
      name: "first",
      runId: "run-1",
      attributes: { value: "before" },
    });
    expect(fs.existsSync(second.path)).toBe(false);
    first.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = first.path;
    emitDiagnosticsTimelineEvent({ type: "mark", name: "third" }, { env: first.env });
    expect(JSON.parse(fs.readFileSync(second.path, "utf8"))).toMatchObject({
      name: "second",
      runId: "changed",
      attributes: { value: "after" },
    });
    expect((await readTimeline(first.path)).map((event) => event.name)).toEqual(["first", "third"]);
  });

  it("bounds queued UTF-8 bytes without dropping bursts or oversized events", async () => {
    const { env, path } = await createTimelineEnv();
    const write = vi.spyOn(fs, "writeSync");
    const names = Array.from({ length: 6 }, (_, index) => `event-${index}`);
    for (const name of names) {
      emitDiagnosticsTimelineEvent(
        { type: "mark", name, attributes: { text: "界".repeat(8192) } },
        { env },
      );
    }
    const chunks = () =>
      write.mock.calls.flatMap(([, content]) => (Buffer.isBuffer(content) ? [content] : []));
    expect(chunks().length).toBeGreaterThan(0);
    expect(chunks().every((content) => content.byteLength <= 64 * 1024)).toBe(true);
    const oversized = "界".repeat(32 * 1024);
    emitDiagnosticsTimelineEvent(
      { type: "mark", name: "oversized", attributes: { text: oversized } },
      { env },
    );
    emitDiagnosticsTimelineEvent({ type: "mark", name: "last" }, { env });
    flushDiagnosticsTimeline();

    expect(chunks().filter((content) => content.byteLength > 64 * 1024)).toHaveLength(1);
    const events = await readTimeline(path);
    expect(events.map((event) => event.name)).toEqual([...names, "oversized", "last"]);
    expect(attributesRecord(eventRecord(events, names.length)).text).toBe(oversized);
  });

  it.each(["natural", "immediate", "first-event-at-exit"])(
    "retains queued and later exit-listener events on %s exit",
    async (mode) => {
      const { env, path } = await createTimelineEnv();
      const script = `
        import { emitDiagnosticsTimelineEvent } from ${JSON.stringify(new URL("./diagnostics-timeline.ts", import.meta.url).href)};
        const env = ${JSON.stringify(env)};
        process.on("exit", () => emitDiagnosticsTimelineEvent({ type: "mark", name: "last" }, { env }));
        ${mode === "first-event-at-exit" ? "" : 'emitDiagnosticsTimelineEvent({ type: "mark", name: "first" }, { env });'}
        ${mode === "natural" ? "" : "process.exit(0);"}
      `;
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url)),
          "--input-type=module",
          "--eval",
          script,
        ],
        { encoding: "utf8", env: { ...process.env, VITEST: "false" }, timeout: 10_000 },
      );

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect((await readTimeline(path)).map((event) => event.name)).toEqual(
        mode === "first-event-at-exit" ? ["last"] : ["first", "last"],
      );
    },
  );

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

  it("writes provider response status as a top-level field", async () => {
    const { env, path } = await createTimelineEnv();

    emitDiagnosticsTimelineEvent(
      {
        type: "provider.request",
        name: "provider.request",
        provider: "openai",
        operation: "openai-responses",
        ok: true,
        status: 200,
      },
      { env },
    );

    const [event] = await readTimeline(path);
    expect(event).toMatchObject({
      type: "provider.request",
      provider: "openai",
      operation: "openai-responses",
      ok: true,
      status: 200,
    });
  });

  it("routes timeline write failures through the captured console boundary once", async () => {
    const { env, path } = await createTimelineEnv();
    await mkdir(dirname(path), { recursive: true });
    const blockingFile = join(dirname(path), "blocked");
    await writeFile(blockingFile, "not a directory");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failingEnv = {
      ...env,
      OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: join(blockingFile, "timeline.jsonl"),
    };

    emitDiagnosticsTimelineEvent({ type: "mark", name: "first" }, { env: failingEnv });
    emitDiagnosticsTimelineEvent({ type: "mark", name: "second" }, { env: failingEnv });
    flushDiagnosticsTimeline();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("failed to write timeline event"));
    emitDiagnosticsTimelineEvent({ type: "mark", name: "recovered" }, { env });
    expect((await readTimeline(path)).map((event) => event.name)).toEqual(["recovered"]);
  });

  it.each(["symlink", "hardlink", "directory"])(
    "keeps unsafe %s targets unchanged when a batch drains",
    async (kind) => {
      const { env, path } = await createTimelineEnv();
      await mkdir(dirname(path), { recursive: true });
      const target = join(dirname(path), "target");
      await writeFile(target, "unchanged");
      if (kind === "symlink") {
        fs.symlinkSync(target, path);
      } else if (kind === "hardlink") {
        fs.linkSync(target, path);
      } else {
        await mkdir(path);
      }
      emitDiagnosticsTimelineEvent({ type: "mark", name: "first" }, { env });
      emitDiagnosticsTimelineEvent({ type: "mark", name: "second" }, { env });
      flushDiagnosticsTimeline();

      expect(await readFile(target, "utf8")).toBe("unchanged");
      if (kind === "directory") {
        expect(fs.readdirSync(path)).toEqual([]);
      }
    },
  );

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

  it("can omit sensitive span error messages", async () => {
    const { env, path } = await createTimelineEnv();

    await expect(
      measureDiagnosticsTimelineSpan(
        "secrets.prepare",
        () => {
          throw new Error('Secret provider "prod" failed for ref "TOKEN_ID"');
        },
        { env, omitErrorMessage: true, phase: "startup" },
      ),
    ).rejects.toThrow("TOKEN_ID");

    const events = await readTimeline(path);
    expect(events).toHaveLength(2);
    const errorEvent = eventRecord(events, 1);
    expect(errorEvent.type).toBe("span.error");
    expect(errorEvent.name).toBe("secrets.prepare");
    expect(errorEvent.errorName).toBe("Error");
    expect(errorEvent.errorMessage).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain("TOKEN_ID");
    expect(JSON.stringify(events)).not.toContain("prod");
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
