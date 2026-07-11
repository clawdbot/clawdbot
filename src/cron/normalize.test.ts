// Cron normalization tests cover job config normalization and defaults.
import { describe, expect, it } from "vitest";
import {
  validateCronAddParams,
  validateCronUpdateParams,
} from "../../packages/gateway-protocol/src/index.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "./normalize.js";

const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000;

function expectNormalizedAtSchedule(scheduleInput: Record<string, unknown>) {
  const normalized = normalizeCronJobCreate({
    name: "iso schedule",
    enabled: true,
    schedule: scheduleInput,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "systemEvent",
      text: "hi",
    },
  }) as unknown as Record<string, unknown>;

  const schedule = normalized.schedule as Record<string, unknown>;
  expect(schedule.kind).toBe("at");
  expect(schedule.at).toBe(new Date(Date.parse("2026-01-12T18:00:00Z")).toISOString());
}

function expectAnnounceDeliveryTarget(
  delivery: Record<string, unknown>,
  params: { channel: string; to: string },
): void {
  expect(delivery.mode).toBe("announce");
  expect(delivery.channel).toBe(params.channel);
  expect(delivery.to).toBe(params.to);
}

function normalizeIsolatedAgentTurnCreateJob(params: {
  name: string;
  payload?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
}): Record<string, unknown> {
  return normalizeCronJobCreate({
    name: params.name,
    enabled: true,
    schedule: { kind: "cron", expr: "* * * * *" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: "hi",
      ...params.payload,
    },
    ...(params.delivery ? { delivery: params.delivery } : {}),
  }) as unknown as Record<string, unknown>;
}

function normalizeMainSystemEventCreateJob(params: {
  name: string;
  schedule: Record<string, unknown>;
}): Record<string, unknown> {
  return normalizeCronJobCreate({
    name: params.name,
    enabled: true,
    schedule: params.schedule,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "systemEvent",
      text: "tick",
    },
  }) as unknown as Record<string, unknown>;
}

describe("normalizeCronJobCreate", () => {
  it("trims cron timezones and drops blank values", () => {
    const trimmed = normalizeMainSystemEventCreateJob({
      name: "trimmed-timezone",
      schedule: { kind: "cron", expr: "0 * * * *", tz: "  Europe/Vienna  " },
    });
    const blank = normalizeMainSystemEventCreateJob({
      name: "blank-timezone",
      schedule: { kind: "cron", expr: "0 * * * *", tz: "   " },
    });

    expect(trimmed.schedule).toMatchObject({ tz: "Europe/Vienna" });
    expect(blank.schedule).not.toHaveProperty("tz");
  });

  it("normalizes trigger scripts and preserves patch clears", () => {
    const normalized = normalizeCronJobCreate({
      name: "watcher",
      enabled: true,
      schedule: { kind: "every", everyMs: 30_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "changed" },
      trigger: { script: "  json({ fire: true })  ", once: "true", ignored: true },
    }) as unknown as Record<string, unknown>;

    expect(normalized.trigger).toEqual({ script: "json({ fire: true })", once: true });
    expect(normalizeCronJobPatch({ trigger: null })).toEqual({ trigger: null });
  });

  it("trims agentId and drops null", () => {
    const normalized = normalizeCronJobCreate({
      name: "agent-set",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      agentId: " Ops ",
      payload: {
        kind: "agentTurn",
        message: "hi",
      },
    }) as unknown as Record<string, unknown>;

    expect(normalized.agentId).toBe("ops");

    const cleared = normalizeCronJobCreate({
      name: "agent-clear",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      agentId: null,
      payload: {
        kind: "agentTurn",
        message: "hi",
      },
    }) as unknown as Record<string, unknown>;

    expect(cleared.agentId).toBeNull();
  });

  it("trims sessionKey and drops blanks", () => {
    const normalized = normalizeCronJobCreate({
      name: "session-key",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      sessionKey: "  agent:main:discord:channel:ops  ",
      payload: { kind: "systemEvent", text: "hi" },
    }) as unknown as Record<string, unknown>;
    expect(normalized.sessionKey).toBe("agent:main:discord:channel:ops");

    const cleared = normalizeCronJobCreate({
      name: "session-key-clear",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      sessionKey: "   ",
      payload: { kind: "systemEvent", text: "hi" },
    }) as unknown as Record<string, unknown>;
    expect("sessionKey" in cleared).toBe(false);
  });

  it("stores the source session key for case-insensitive current targets", () => {
    const normalized = normalizeCronJobCreate(
      {
        name: "current target",
        enabled: true,
        schedule: { kind: "cron", expr: "* * * * *" },
        sessionTarget: " Current ",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "hi" },
      },
      { sessionContext: { sessionKey: " agent:main:telegram:direct:42 " } },
    ) as unknown as Record<string, unknown>;

    expect(normalized.sessionTarget).toBe("current");
    expect(normalized.sessionKey).toBe("agent:main:telegram:direct:42");
  });

  it("canonicalizes delivery.channel casing", () => {
    const normalized = normalizeIsolatedAgentTurnCreateJob({
      name: "delivery channel casing",
      delivery: {
        mode: "announce",
        channel: "Telegram",
        to: "7200373102",
      },
    });

    const delivery = normalized.delivery as Record<string, unknown>;
    expectAnnounceDeliveryTarget(delivery, { channel: "telegram", to: "7200373102" });
  });

  it("preserves explicit null model clear in payload patches", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        kind: "agentTurn",
        model: null,
      },
    }) as unknown as Record<string, { model?: unknown }>;

    expect(normalized.payload?.model).toBeNull();
  });

  it("preserves explicit null thinking clear in payload patches", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        kind: "agentTurn",
        thinking: null,
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.thinking).toBeNull();
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });

  it("coerces ISO schedule.at to normalized ISO (UTC)", () => {
    expectNormalizedAtSchedule({ kind: "at", at: "2026-01-12T18:00:00" });
  });

  it("defaults cron stagger for recurring top-of-hour schedules", () => {
    const normalized = normalizeMainSystemEventCreateJob({
      name: "hourly",
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    });

    const schedule = normalized.schedule as Record<string, unknown>;
    expect(schedule.staggerMs).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });

  it("preserves explicit exact cron schedule", () => {
    const normalized = normalizeMainSystemEventCreateJob({
      name: "exact",
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC", staggerMs: 0 },
    });

    const schedule = normalized.schedule as Record<string, unknown>;
    expect(schedule.staggerMs).toBe(0);
  });

  it("defaults deleteAfterRun for one-shot schedules", () => {
    const normalized = normalizeCronJobCreate({
      name: "default delete",
      enabled: true,
      schedule: { kind: "at", at: "2026-01-12T18:00:00Z" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: {
        kind: "systemEvent",
        text: "hi",
      },
    }) as unknown as Record<string, unknown>;

    expect(normalized.deleteAfterRun).toBe(true);
  });

  it("normalizes delivery mode and channel", () => {
    const normalized = normalizeIsolatedAgentTurnCreateJob({
      name: "delivery",
      delivery: {
        mode: " ANNOUNCE ",
        channel: " TeLeGrAm ",
        to: " 7200373102 ",
      },
    });

    const delivery = normalized.delivery as Record<string, unknown>;
    expectAnnounceDeliveryTarget(delivery, { channel: "telegram", to: "7200373102" });
  });

  it("normalizes whitespace-only payload text to empty strings so validation rejects it", () => {
    const agentTurn = normalizeCronJobCreate({
      name: "blank agent turn",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "   ",
      },
    }) as unknown as Record<string, unknown>;
    expect(agentTurn.payload).toEqual({ kind: "agentTurn", message: "" });
    expect(validateCronAddParams(agentTurn)).toBe(false);

    const systemEvent = normalizeCronJobCreate({
      name: "blank system event",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: {
        kind: "systemEvent",
        text: "   ",
      },
    }) as unknown as Record<string, unknown>;
    expect(systemEvent.payload).toEqual({ kind: "systemEvent", text: "" });
    expect(validateCronAddParams(systemEvent)).toBe(false);

    const update = normalizeCronJobPatch({
      payload: { kind: "agentTurn", message: "   " },
    }) as unknown as Record<string, unknown>;
    expect(update.payload).toEqual({ kind: "agentTurn", message: "" });
    expect(validateCronUpdateParams({ id: "job-1", patch: update })).toBe(false);
  });

  it("normalizes delivery accountId and strips blanks", () => {
    const normalized = normalizeIsolatedAgentTurnCreateJob({
      name: "delivery account",
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "-1003816714067",
        accountId: " coordinator ",
      },
    });

    const delivery = normalized.delivery as Record<string, unknown>;
    expect(delivery.accountId).toBe("coordinator");
  });

  it("normalizes delivery threadId and preserves numeric values", () => {
    const stringThread = normalizeIsolatedAgentTurnCreateJob({
      name: "delivery thread string",
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "-1003816714067",
        threadId: " 1008013 ",
      },
    });

    expect((stringThread.delivery as Record<string, unknown>).threadId).toBe("1008013");

    const numericThread = normalizeIsolatedAgentTurnCreateJob({
      name: "delivery thread number",
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "-1003816714067",
        threadId: 1008013,
      },
    });

    expect((numericThread.delivery as Record<string, unknown>).threadId).toBe(1008013);
  });

  it("strips empty accountId from delivery", () => {
    const normalized = normalizeIsolatedAgentTurnCreateJob({
      name: "empty account",
      delivery: {
        mode: "announce",
        channel: "telegram",
        accountId: "   ",
      },
    });

    const delivery = normalized.delivery as Record<string, unknown>;
    expect("accountId" in delivery).toBe(false);
  });

  it("normalizes webhook delivery mode and target URL", () => {
    const normalized = normalizeCronJobCreate({
      name: "webhook delivery",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello" },
      delivery: {
        mode: " WeBhOoK ",
        to: " https://example.invalid/cron ",
      },
    }) as unknown as Record<string, unknown>;

    const delivery = normalized.delivery as Record<string, unknown>;
    expect(delivery.mode).toBe("webhook");
    expect(delivery.to).toBe("https://example.invalid/cron");
  });

  it("preserves invalid completion webhook create shapes for validation", () => {
    const normalized = normalizeCronJobCreate({
      name: "completion without announce",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello" },
      delivery: {
        mode: "none",
        completionDestination: {
          mode: " WeBhOoK ",
          to: " https://example.invalid/complete ",
        },
      },
    }) as unknown as Record<string, unknown>;

    const delivery = normalized.delivery as Record<string, unknown>;
    expect(delivery.completionDestination).toEqual({
      mode: "webhook",
      to: "https://example.invalid/complete",
    });
    expect(validateCronAddParams(normalized)).toBe(false);
  });

  it("does not default explicit mode-less delivery objects to announce", () => {
    const normalized = normalizeCronJobCreate({
      name: "implicit announce",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hello" },
      delivery: {
        channel: "telegram",
        to: "123",
      },
    }) as unknown as Record<string, unknown>;

    const delivery = normalized.delivery as Record<string, unknown>;
    expect(delivery.mode).toBeUndefined();
    expect(delivery.channel).toBe("telegram");
    expect(delivery.to).toBe("123");
    expect(validateCronAddParams(normalized)).toBe(false);
  });

  it("defaults isolated agentTurn delivery to announce", () => {
    const normalized = normalizeIsolatedAgentTurnCreateJob({
      name: "default-announce",
    });

    const delivery = normalized.delivery as Record<string, unknown>;
    expect(delivery.mode).toBe("announce");
  });

  it("defaults command payloads to isolated announce jobs", () => {
    const normalized = normalizeCronJobCreate({
      name: "command default",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: {
        kind: "command",
        argv: ["sh", "-lc", "echo ok"],
        cwd: " /srv/example ",
        env: { FOO: "bar" },
        timeoutSeconds: 30,
        noOutputTimeoutSeconds: 5,
        outputMaxBytes: 4096,
      },
    }) as unknown as Record<string, unknown>;

    expect(normalized.sessionTarget).toBe("isolated");
    expect((normalized.delivery as Record<string, unknown>).mode).toBe("announce");
    expect(normalized.payload).toEqual({
      kind: "command",
      argv: ["sh", "-lc", "echo ok"],
      cwd: "/srv/example",
      env: { FOO: "bar" },
      timeoutSeconds: 30,
      noOutputTimeoutSeconds: 5,
      outputMaxBytes: 4096,
    });
    expect(validateCronAddParams(normalized)).toBe(true);
  });

  it("preserves command argv argument bytes", () => {
    const normalized = normalizeCronJobCreate({
      name: "command exact argv",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: {
        kind: "command",
        argv: ["printf", "%s", "  padded value  "],
      },
    }) as unknown as Record<string, unknown>;

    expect(normalized.payload).toMatchObject({
      kind: "command",
      argv: ["printf", "%s", "  padded value  "],
    });
    expect(validateCronAddParams(normalized)).toBe(true);
  });

  it("preserves timeoutSeconds=0 for no-timeout agentTurn payloads", () => {
    const normalized = normalizeCronJobCreate({
      name: "no-timeout",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "hello", timeoutSeconds: 0 },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.timeoutSeconds).toBe(0);
  });

  it("preserves fractional timeoutSeconds for short agentTurn deadlines", () => {
    const normalized = normalizeCronJobCreate({
      name: "fractional timeout",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "hello", timeoutSeconds: 0.03 },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.timeoutSeconds).toBe(0.03);
  });

  it("drops negative agentTurn timeoutSeconds instead of converting it to no-timeout", () => {
    const nested = normalizeCronJobCreate({
      name: "negative nested timeout",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "hello", timeoutSeconds: -5 },
    }) as unknown as Record<string, unknown>;
    const flattened = normalizeCronJobCreate({
      name: "negative flat timeout",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "hello" },
      timeoutSeconds: -5,
    }) as unknown as Record<string, unknown>;

    expect(nested.payload).not.toHaveProperty("timeoutSeconds");
    expect(flattened.payload).not.toHaveProperty("timeoutSeconds");
  });

  it("preserves empty toolsAllow lists for create jobs", () => {
    const normalized = normalizeCronJobCreate({
      name: "empty-tools",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "hello",
        toolsAllow: [],
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.toolsAllow).toStrictEqual([]);
    expect(validateCronAddParams(normalized)).toBe(true);
  });

  it("promotes implicit text payloads with agentTurn hints to agentTurn create jobs", () => {
    const normalized = normalizeCronJobCreate({
      name: "implicit-agent-turn",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: {
        text: " summarize the build ",
        model: " openai/gpt-5 ",
        fallbacks: [" anthropic/claude-haiku-3-5 "],
        thinking: " high ",
        timeoutSeconds: 45,
        lightContext: true,
        toolsAllow: [" read "],
        allowUnsafeExternalContent: true,
      },
    }) as unknown as Record<string, unknown>;

    expect(normalized.sessionTarget).toBe("isolated");
    expect((normalized.delivery as Record<string, unknown>).mode).toBe("announce");
    expect(normalized.payload).toEqual({
      kind: "agentTurn",
      message: "summarize the build",
      model: "openai/gpt-5",
      fallbacks: ["anthropic/claude-haiku-3-5"],
      thinking: "high",
      timeoutSeconds: 45,
      lightContext: true,
      toolsAllow: ["read"],
      allowUnsafeExternalContent: true,
    });
    expect(validateCronAddParams(normalized)).toBe(true);
  });

  it("prunes agentTurn-only payload fields from systemEvent create jobs", () => {
    const normalized = normalizeCronJobCreate({
      name: "system-event-prune",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: {
        kind: "systemEvent",
        text: "hello",
        model: "openai/gpt-5",
        fallbacks: ["openai/gpt-4.1-mini"],
        thinking: "high",
        timeoutSeconds: 45,
        lightContext: true,
        toolsAllow: ["exec"],
        allowUnsafeExternalContent: true,
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload).toEqual({ kind: "systemEvent", text: "hello" });
    expect(validateCronAddParams(normalized)).toBe(true);
  });

  it("prunes schedule fields that do not belong to at schedules for create jobs", () => {
    const normalized = normalizeCronJobCreate({
      name: "at-prune",
      schedule: {
        kind: "at",
        at: "2026-01-12T18:00:00Z",
        expr: "* * * * *",
        everyMs: 60_000,
        anchorMs: 123,
        tz: "UTC",
        staggerMs: 30_000,
      },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: {
        kind: "systemEvent",
        text: "hi",
      },
    }) as unknown as Record<string, unknown>;

    const schedule = normalized.schedule as Record<string, unknown>;
    expect(schedule).toEqual({
      kind: "at",
      at: new Date("2026-01-12T18:00:00Z").toISOString(),
    });
    expect(validateCronAddParams(normalized)).toBe(true);
  });

  it("prunes staggerMs from every schedules for create jobs", () => {
    const normalized = normalizeCronJobCreate({
      name: "every-prune",
      schedule: {
        kind: "every",
        everyMs: 60_000,
        staggerMs: 30_000,
      },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: {
        kind: "systemEvent",
        text: "hi",
      },
    }) as unknown as Record<string, unknown>;

    const schedule = normalized.schedule as Record<string, unknown>;
    expect(schedule).toEqual({
      kind: "every",
      everyMs: 60_000,
    });
    expect(validateCronAddParams(normalized)).toBe(true);
  });

  it("normalizes string every schedule numbers for create jobs", () => {
    const normalized = normalizeCronJobCreate({
      name: "every-string",
      schedule: {
        kind: "every",
        everyMs: "60000",
        anchorMs: "123.9",
      },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: {
        kind: "systemEvent",
        text: "hi",
      },
    }) as unknown as Record<string, unknown>;

    const schedule = normalized.schedule as Record<string, unknown>;
    expect(schedule).toEqual({
      kind: "every",
      everyMs: 60_000,
      anchorMs: 123,
    });
    expect(validateCronAddParams(normalized)).toBe(true);
  });

  it("normalizes string every schedule numbers for patches", () => {
    const normalized = normalizeCronJobPatch({
      schedule: {
        kind: "every",
        everyMs: "60000",
        anchorMs: "123.9",
      },
    }) as unknown as Record<string, unknown>;

    const schedule = normalized.schedule as Record<string, unknown>;
    expect(schedule).toEqual({
      kind: "every",
      everyMs: 60_000,
      anchorMs: 123,
    });
    expect(validateCronUpdateParams({ id: "job", patch: normalized })).toBe(true);

    const nested = normalizeCronJobPatch({
      delivery: {
        failureDestination: {
          channel: null,
          to: null,
          accountId: null,
          mode: null,
        },
      },
    }) as unknown as Record<string, unknown>;

    expect(nested.delivery).toEqual({
      failureDestination: {
        channel: null,
        to: null,
        accountId: null,
        mode: null,
      },
    });
    expect(validateCronUpdateParams({ id: "job", patch: nested })).toBe(true);
  });

  it("keeps invalid every schedule numbers invalid for validation", () => {
    const zeroEvery = normalizeCronJobCreate({
      name: "every-zero",
      schedule: {
        kind: "every",
        everyMs: "0",
      },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: {
        kind: "systemEvent",
        text: "hi",
      },
    }) as unknown as Record<string, unknown>;
    expect(validateCronAddParams(zeroEvery)).toBe(false);

    const negativeAnchor = normalizeCronJobPatch({
      schedule: {
        kind: "every",
        everyMs: "60000",
        anchorMs: "-1",
      },
    }) as unknown as Record<string, unknown>;
    expect(validateCronUpdateParams({ id: "job", patch: negativeAnchor })).toBe(false);
  });

  it("coerces sessionTarget and wakeMode casing", () => {
    const normalized = normalizeCronJobCreate({
      name: "casing",
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: " IsOlAtEd ",
      wakeMode: " NOW ",
      payload: { kind: "agentTurn", message: "hello" },
    }) as unknown as Record<string, unknown>;

    expect(normalized.sessionTarget).toBe("isolated");
    expect(normalized.wakeMode).toBe("now");
  });

  it("strips invalid delivery mode from partial delivery objects", () => {
    const normalized = normalizeCronJobCreate({
      name: "delivery mode",
      schedule: { kind: "cron", expr: "* * * * *" },
      payload: { kind: "agentTurn", message: "hello" },
      delivery: { mode: "bogus", to: "123" },
    }) as unknown as Record<string, unknown>;

    const delivery = normalized.delivery as Record<string, unknown>;
    expect(delivery.mode).toBeUndefined();
    expect(delivery.to).toBe("123");
  });

  it("stores current sessionTarget source context when context is available", () => {
    const normalized = normalizeCronJobCreate(
      {
        name: "current-session",
        schedule: { kind: "cron", expr: "* * * * *" },
        sessionTarget: "current",
        payload: { kind: "agentTurn", message: "hello" },
      },
      { sessionContext: { sessionKey: "agent:main:discord:group:ops" } },
    ) as unknown as Record<string, unknown>;

    expect(normalized.sessionTarget).toBe("current");
    expect(normalized.sessionKey).toBe("agent:main:discord:group:ops");
  });

  it("falls back current sessionTarget to isolated without context", () => {
    const normalized = normalizeCronJobCreate({
      name: "current-without-context",
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "current",
      payload: { kind: "agentTurn", message: "hello" },
    }) as unknown as Record<string, unknown>;

    expect(normalized.sessionTarget).toBe("isolated");
  });

  it("preserves custom session ids with a session: prefix", () => {
    const normalized = normalizeCronJobCreate({
      name: "custom-session",
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "session:MySessionID",
      payload: { kind: "agentTurn", message: "hello" },
    }) as unknown as Record<string, unknown>;

    expect(normalized.sessionTarget).toBe("session:MySessionID");
  });

  it("preserves custom session ids with channel-native separators", () => {
    const created = normalizeCronJobCreate({
      name: "dingtalk-group",
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "session:agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==",
      payload: { kind: "agentTurn", message: "hello" },
    }) as unknown as Record<string, unknown>;

    expect(created.sessionTarget).toBe(
      "session:agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==",
    );

    const patched = normalizeCronJobPatch({
      sessionTarget: "session:..\\outside",
    }) as unknown as Record<string, unknown>;
    expect(patched.sessionTarget).toBe("session:..\\outside");
  });

  it("rejects null bytes in custom session ids", () => {
    expect(() =>
      normalizeCronJobCreate({
        name: "null-byte-session",
        schedule: { kind: "cron", expr: "* * * * *" },
        sessionTarget: "session:bad\0id",
        payload: { kind: "agentTurn", message: "hello" },
      }),
    ).toThrow("invalid cron sessionTarget session id");
  });
});

describe("normalizeCronJobPatch", () => {
  it("normalizes agentTurn model-only payload patches", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        kind: "agentTurn",
        model: "anthropic/claude-sonnet-4-6",
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("preserves empty fallback lists so patches can disable fallbacks", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        kind: "agentTurn",
        fallbacks: [],
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.fallbacks).toStrictEqual([]);
  });

  it("preserves empty toolsAllow lists so patches can disable all tools", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        kind: "agentTurn",
        toolsAllow: [],
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.toolsAllow).toStrictEqual([]);
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });

  it("normalizes agentTurn fallback-only payload patches", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        kind: "agentTurn",
        fallbacks: [" openrouter/gpt-4.1-mini ", "anthropic/claude-haiku-3-5"],
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.fallbacks).toEqual(["openrouter/gpt-4.1-mini", "anthropic/claude-haiku-3-5"]);
  });

  it("drops malformed agentTurn fallback-only payload patches", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        kind: "agentTurn",
        fallbacks: [123],
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.fallbacks).toBeUndefined();
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });

  it("normalizes agentTurn toolsAllow-only payload patches", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        kind: "agentTurn",
        toolsAllow: [" exec ", " read "],
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.toolsAllow).toEqual(["exec", "read"]);
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });

  it("drops malformed agentTurn toolsAllow-only payload patches", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        kind: "agentTurn",
        toolsAllow: [123],
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.toolsAllow).toBeUndefined();
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });

  it("preserves null toolsAllow so patches can clear the allow-list", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        kind: "agentTurn",
        toolsAllow: null,
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.toolsAllow).toBeNull();
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });

  it("preserves null fallback lists so patches can clear the fallback override", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        kind: "agentTurn",
        fallbacks: null,
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.fallbacks).toBeNull();
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });

  it("promotes implicit text payloads with agentTurn hints to agentTurn patches", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        text: " continue the report ",
        toolsAllow: [" read "],
      },
    }) as unknown as Record<string, unknown>;

    expect(normalized.payload).toEqual({
      kind: "agentTurn",
      message: "continue the report",
      toolsAllow: ["read"],
    });
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });

  it("preserves null sessionKey patches and trims string values", () => {
    const trimmed = normalizeCronJobPatch({
      sessionKey: "  agent:main:telegram:group:-100123  ",
    }) as unknown as Record<string, unknown>;
    expect(trimmed.sessionKey).toBe("agent:main:telegram:group:-100123");

    const cleared = normalizeCronJobPatch({
      sessionKey: null,
    }) as unknown as Record<string, unknown>;
    expect(cleared.sessionKey).toBeNull();
  });

  it("preserves completion webhook patches without delivery mode", () => {
    const normalized = normalizeCronJobPatch({
      delivery: {
        completionDestination: {
          mode: " WeBhOoK ",
          to: " https://example.invalid/complete ",
        },
      },
    }) as unknown as Record<string, unknown>;

    expect(normalized.delivery).toEqual({
      completionDestination: {
        mode: "webhook",
        to: "https://example.invalid/complete",
      },
    });
    expect(validateCronUpdateParams({ id: "job", patch: normalized })).toBe(true);
  });

  it("preserves nullable delivery field clears in patches", () => {
    const normalized = normalizeCronJobPatch({
      delivery: {
        channel: null,
        to: null,
        threadId: null,
        accountId: null,
        failureDestination: null,
      },
    }) as unknown as Record<string, unknown>;

    expect(normalized.delivery).toEqual({
      channel: null,
      to: null,
      threadId: null,
      accountId: null,
      failureDestination: null,
    });
    expect(validateCronUpdateParams({ id: "job", patch: normalized })).toBe(true);
  });

  it("normalizes cron stagger values in patch schedules", () => {
    const normalized = normalizeCronJobPatch({
      schedule: { kind: "cron", expr: "0 * * * *", staggerMs: "30000" },
    }) as unknown as Record<string, unknown>;

    const schedule = normalized.schedule as Record<string, unknown>;
    expect(schedule.staggerMs).toBe(30_000);
  });

  it("prunes agentTurn-only payload fields from systemEvent patch payloads", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        kind: "systemEvent",
        text: "hi",
        model: "openai/gpt-5",
        fallbacks: ["openai/gpt-4.1-mini"],
        thinking: "high",
        timeoutSeconds: 15,
        lightContext: true,
        toolsAllow: ["exec"],
        allowUnsafeExternalContent: true,
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload).toEqual({ kind: "systemEvent", text: "hi" });
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });

  it("prunes schedule fields that do not belong to at schedules for patches", () => {
    const normalized = normalizeCronJobPatch({
      schedule: {
        kind: "at",
        at: "2026-01-12T18:00:00Z",
        expr: "* * * * *",
        everyMs: 60_000,
        anchorMs: 123,
        tz: "UTC",
        staggerMs: 30_000,
      },
    }) as unknown as Record<string, unknown>;

    const schedule = normalized.schedule as Record<string, unknown>;
    expect(schedule).toEqual({
      kind: "at",
      at: new Date("2026-01-12T18:00:00Z").toISOString(),
    });
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });

  it("prunes staggerMs from every schedules for patches", () => {
    const normalized = normalizeCronJobPatch({
      schedule: {
        kind: "every",
        everyMs: 60_000,
        staggerMs: 30_000,
      },
    }) as unknown as Record<string, unknown>;

    const schedule = normalized.schedule as Record<string, unknown>;
    expect(schedule).toEqual({
      kind: "every",
      everyMs: 60_000,
    });
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });
});

describe("on-exit schedule normalization", () => {
  it("keeps command/cwd and strips time fields for on-exit jobs", () => {
    const normalized = normalizeCronJobCreate({
      name: "watch build",
      schedule: {
        kind: "on-exit",
        command: "make build",
        cwd: "/repo",
        // stale fields from a prior kind that must be dropped
        everyMs: 1000,
        expr: "* * * * *",
        at: "2026-01-01T00:00:00Z",
      },
      payload: { kind: "systemEvent", text: "build done" },
      sessionTarget: "main",
    });
    expect(normalized).not.toBeNull();
    expect(normalized?.schedule).toEqual({ kind: "on-exit", command: "make build", cwd: "/repo" });
    expect(validateCronAddParams(normalized)).toBe(true);
  });

  it("drops command/cwd when normalizing a non-on-exit schedule", () => {
    const normalized = normalizeCronJobCreate({
      name: "interval",
      schedule: { kind: "every", everyMs: 5000, command: "leftover", cwd: "/x" },
      payload: { kind: "systemEvent", text: "tick" },
      sessionTarget: "main",
    });
    expect(normalized).not.toBeNull();
    expect(normalized?.schedule).not.toHaveProperty("command");
    expect(normalized?.schedule).not.toHaveProperty("cwd");
  });
});
