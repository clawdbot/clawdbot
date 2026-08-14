// Cron normalization tests cover job config normalization and defaults.
import { describe, expect, it } from "vitest";
import {
  validateCronAddParams,
  validateCronUpdateParams,
} from "../../packages/gateway-protocol/src/index.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "./normalize.js";

type UnknownRecord = Record<string, unknown>;

const CRON_SCHEDULE = { kind: "cron", expr: "* * * * *" };
const EVERY_SCHEDULE = { kind: "every", everyMs: 60_000 };
const AGENT_TURN = { kind: "agentTurn", message: "hello" };
const SYSTEM_EVENT = { kind: "systemEvent", text: "hi" };
const STALE_AT_SCHEDULE = {
  kind: "at",
  at: "2026-01-12T18:00:00Z",
  expr: "* * * * *",
  everyMs: 60_000,
  anchorMs: 123,
  tz: "UTC",
  staggerMs: 30_000,
};
const NORMALIZED_AT_SCHEDULE = {
  kind: "at",
  at: new Date("2026-01-12T18:00:00Z").toISOString(),
};
const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000;

function normalizeCreate(raw: UnknownRecord, sessionKey?: string): UnknownRecord {
  return normalizeCronJobCreate(
    raw,
    sessionKey ? { sessionContext: { sessionKey } } : undefined,
  ) as unknown as UnknownRecord;
}

function createMain(overrides: UnknownRecord = {}): UnknownRecord {
  return normalizeCreate({
    name: "test",
    enabled: true,
    schedule: CRON_SCHEDULE,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: SYSTEM_EVENT,
    ...overrides,
  });
}

function createAgent(overrides: UnknownRecord = {}, sessionKey?: string): UnknownRecord {
  return normalizeCreate(
    {
      name: "test",
      enabled: true,
      schedule: CRON_SCHEDULE,
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: AGENT_TURN,
      ...overrides,
    },
    sessionKey,
  );
}

function createDefaulted(payload: UnknownRecord, overrides: UnknownRecord = {}): UnknownRecord {
  return normalizeCreate({ name: "test", schedule: EVERY_SCHEDULE, payload, ...overrides });
}

function normalizePatch(raw: UnknownRecord): UnknownRecord {
  return normalizeCronJobPatch(raw) as unknown as UnknownRecord;
}

function child(record: UnknownRecord, key: string): UnknownRecord {
  return record[key] as UnknownRecord;
}

function mainSchedule(schedule: UnknownRecord): UnknownRecord {
  return child(createMain({ schedule }), "schedule");
}

function agentDelivery(delivery: UnknownRecord): UnknownRecord {
  return child(createAgent({ delivery }), "delivery");
}

function patchAgent(payloadPatch: UnknownRecord): {
  normalized: UnknownRecord;
  payload: UnknownRecord;
} {
  const normalized = normalizePatch({ payload: { kind: "agentTurn", ...payloadPatch } });
  return { normalized, payload: child(normalized, "payload") };
}

function expectAnnounceDeliveryTarget(
  delivery: UnknownRecord,
  params: { channel: string; to: string },
): void {
  expect(delivery.mode).toBe("announce");
  expect(delivery.channel).toBe(params.channel);
  expect(delivery.to).toBe(params.to);
}
describe("normalizeCronJobCreate", () => {
  it("trims cron timezones and drops blank values", () => {
    const trimmed = mainSchedule({ ...CRON_SCHEDULE, tz: "  Europe/Vienna  " });
    const blank = mainSchedule({ ...CRON_SCHEDULE, tz: "   " });
    expect(trimmed).toMatchObject({ tz: "Europe/Vienna" });
    expect(blank).not.toHaveProperty("tz");
  });
  it("normalizes trigger scripts and preserves patch clears", () => {
    const normalized = createMain({
      schedule: { kind: "every", everyMs: 30_000 },
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "changed" },
      trigger: { script: "  json({ fire: true })  ", once: "true", ignored: true },
    });
    expect(normalized.trigger).toEqual({ script: "json({ fire: true })", once: true });
    expect(normalizeCronJobPatch({ trigger: null })).toEqual({ trigger: null });
  });
  it("trims agentId and drops null", () => {
    const normalized = createAgent({ agentId: " Ops " });
    const cleared = createAgent({ agentId: null });
    expect(normalized.agentId).toBe("ops");
    expect(cleared.agentId).toBeNull();
  });
  it("trims sessionKey and drops blanks", () => {
    const normalized = createMain({ sessionKey: "  agent:main:discord:channel:ops  " });
    const cleared = createMain({ sessionKey: "   " });
    expect(normalized.sessionKey).toBe("agent:main:discord:channel:ops");
    expect("sessionKey" in cleared).toBe(false);
  });
  it("stores the source session key for case-insensitive current targets", () => {
    const normalized = createAgent(
      { sessionTarget: " Current ", payload: { kind: "agentTurn", message: "hi" } },
      " agent:main:telegram:direct:42 ",
    );
    expect(normalized.sessionTarget).toBe("current");
    expect(normalized.sessionKey).toBe("agent:main:telegram:direct:42");
  });
  it("canonicalizes delivery.channel casing", () => {
    const delivery = agentDelivery({ mode: "announce", channel: "Telegram", to: "7200373102" });
    expectAnnounceDeliveryTarget(delivery, { channel: "telegram", to: "7200373102" });
  });
  it("preserves explicit null model clear in payload patches", () => {
    const normalized = normalizePatch({ payload: { kind: "agentTurn", model: null } });
    expect(child(normalized, "payload").model).toBeNull();
  });
  it("preserves explicit null thinking clear in payload patches", () => {
    const normalized = normalizePatch({ payload: { kind: "agentTurn", thinking: null } });
    const payload = child(normalized, "payload");
    expect(payload.kind).toBe("agentTurn");
    expect(payload.thinking).toBeNull();
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });
  it("coerces ISO schedule.at to normalized ISO (UTC)", () => {
    const schedule = mainSchedule({ kind: "at", at: "2026-01-12T18:00:00" });
    expect(schedule.kind).toBe("at");
    expect(schedule.at).toBe(new Date(Date.parse("2026-01-12T18:00:00Z")).toISOString());
  });
  it("defaults cron stagger for recurring top-of-hour schedules", () => {
    const schedule = mainSchedule({ kind: "cron", expr: "0 * * * *", tz: "UTC" });
    expect(schedule.staggerMs).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });
  it("preserves explicit exact cron schedule", () => {
    const schedule = mainSchedule({ kind: "cron", expr: "0 * * * *", tz: "UTC", staggerMs: 0 });
    expect(schedule.staggerMs).toBe(0);
  });
  it("defaults deleteAfterRun for one-shot schedules", () => {
    const normalized = createMain({ schedule: { kind: "at", at: "2026-01-12T18:00:00Z" } });
    expect(normalized.deleteAfterRun).toBe(true);
  });
  it("normalizes delivery mode and channel", () => {
    const delivery = agentDelivery({
      mode: " ANNOUNCE ",
      channel: " TeLeGrAm ",
      to: " 7200373102 ",
    });
    expectAnnounceDeliveryTarget(delivery, { channel: "telegram", to: "7200373102" });
  });
  it("normalizes whitespace-only payload text to empty strings so validation rejects it", () => {
    const agentTurn = createAgent({
      schedule: EVERY_SCHEDULE,
      payload: { kind: "agentTurn", message: "   " },
    });
    const systemEvent = createMain({
      schedule: EVERY_SCHEDULE,
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "   " },
    });
    const update = normalizePatch({ payload: { kind: "agentTurn", message: "   " } });
    expect(agentTurn.payload).toEqual({ kind: "agentTurn", message: "" });
    expect(validateCronAddParams(agentTurn)).toBe(false);
    expect(systemEvent.payload).toEqual({ kind: "systemEvent", text: "" });
    expect(validateCronAddParams(systemEvent)).toBe(false);
    expect(update.payload).toEqual({ kind: "agentTurn", message: "" });
    expect(validateCronUpdateParams({ id: "job-1", patch: update })).toBe(false);
  });
  it("normalizes delivery accountId and strips blanks", () => {
    const delivery = agentDelivery({
      mode: "announce",
      channel: "telegram",
      to: "-1003816714067",
      accountId: " coordinator ",
    });
    expect(delivery.accountId).toBe("coordinator");
  });
  it("normalizes delivery threadId and preserves numeric values", () => {
    const stringDelivery = agentDelivery({
      mode: "announce",
      channel: "telegram",
      to: "-1003816714067",
      threadId: " 1008013 ",
    });
    const numericDelivery = agentDelivery({
      mode: "announce",
      channel: "telegram",
      to: "-1003816714067",
      threadId: 1008013,
    });
    expect(stringDelivery.threadId).toBe("1008013");
    expect(numericDelivery.threadId).toBe(1008013);
  });
  it("strips empty accountId from delivery", () => {
    const delivery = agentDelivery({ mode: "announce", channel: "telegram", accountId: "   " });
    expect("accountId" in delivery).toBe(false);
  });
  it("normalizes webhook delivery mode and target URL", () => {
    const delivery = child(
      createMain({
        schedule: EVERY_SCHEDULE,
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "hello" },
        delivery: { mode: " WeBhOoK ", to: " https://example.invalid/cron " },
      }),
      "delivery",
    );
    expect(delivery.mode).toBe("webhook");
    expect(delivery.to).toBe("https://example.invalid/cron");
  });
  it("preserves invalid completion webhook create shapes for validation", () => {
    const normalized = createMain({
      schedule: EVERY_SCHEDULE,
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello" },
      delivery: {
        mode: "none",
        completionDestination: { mode: " WeBhOoK ", to: " https://example.invalid/complete " },
      },
    });
    expect(child(normalized, "delivery").completionDestination).toEqual({
      mode: "webhook",
      to: "https://example.invalid/complete",
    });
    expect(validateCronAddParams(normalized)).toBe(false);
  });
  it("does not default explicit mode-less delivery objects to announce", () => {
    const normalized = createAgent({
      schedule: EVERY_SCHEDULE,
      delivery: { channel: "telegram", to: "123" },
    });
    const delivery = child(normalized, "delivery");
    expect(delivery.mode).toBeUndefined();
    expect(delivery.channel).toBe("telegram");
    expect(delivery.to).toBe("123");
    expect(validateCronAddParams(normalized)).toBe(false);
  });
  it("defaults isolated agentTurn delivery to announce", () => {
    expect(child(createAgent(), "delivery").mode).toBe("announce");
  });
  it("defaults command payloads to isolated announce jobs", () => {
    const normalized = createDefaulted({
      kind: "command",
      argv: ["sh", "-lc", "echo ok"],
      cwd: " /srv/example ",
      env: { FOO: "bar" },
      timeoutSeconds: 30,
      noOutputTimeoutSeconds: 5,
      outputMaxBytes: 4096,
    });
    expect(normalized.sessionTarget).toBe("isolated");
    expect(child(normalized, "delivery").mode).toBe("announce");
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
    const normalized = createDefaulted({
      kind: "command",
      argv: ["printf", "%s", "  padded value  "],
    });
    expect(normalized.payload).toMatchObject({
      kind: "command",
      argv: ["printf", "%s", "  padded value  "],
    });
    expect(validateCronAddParams(normalized)).toBe(true);
  });
  it("preserves timeoutSeconds=0 for no-timeout agentTurn payloads", () => {
    expect(
      child(createDefaulted({ ...AGENT_TURN, timeoutSeconds: 0 }), "payload").timeoutSeconds,
    ).toBe(0);
  });
  it("preserves fractional timeoutSeconds for short agentTurn deadlines", () => {
    expect(
      child(createDefaulted({ ...AGENT_TURN, timeoutSeconds: 0.03 }), "payload").timeoutSeconds,
    ).toBe(0.03);
  });
  it("drops negative agentTurn timeoutSeconds instead of converting it to no-timeout", () => {
    const nested = createDefaulted({ ...AGENT_TURN, timeoutSeconds: -5 });
    const flattened = createDefaulted(AGENT_TURN, { timeoutSeconds: -5 });
    expect(nested.payload).not.toHaveProperty("timeoutSeconds");
    expect(flattened.payload).not.toHaveProperty("timeoutSeconds");
  });
  it("preserves empty toolsAllow lists for create jobs", () => {
    const normalized = createAgent({
      schedule: EVERY_SCHEDULE,
      payload: { ...AGENT_TURN, toolsAllow: [] },
    });
    expect(child(normalized, "payload").toolsAllow).toStrictEqual([]);
    expect(validateCronAddParams(normalized)).toBe(true);
  });
  it("promotes implicit text payloads with agentTurn hints to agentTurn create jobs", () => {
    const normalized = createDefaulted({
      text: " summarize the build ",
      model: " openai/gpt-5 ",
      fallbacks: [" anthropic/claude-haiku-3-5 "],
      thinking: " high ",
      timeoutSeconds: 45,
      lightContext: true,
      toolsAllow: [" read "],
      allowUnsafeExternalContent: true,
    });
    expect(normalized.sessionTarget).toBe("isolated");
    expect(child(normalized, "delivery").mode).toBe("announce");
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
  it("retains toolsAllow while pruning agentTurn-only fields from systemEvent create jobs", () => {
    const normalized = createMain({
      schedule: EVERY_SCHEDULE,
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
    });
    expect(normalized.payload).toEqual({
      kind: "systemEvent",
      text: "hello",
      toolsAllow: ["exec"],
    });
    expect(validateCronAddParams(normalized)).toBe(true);
  });
  it("prunes schedule fields that do not belong to at schedules for create jobs", () => {
    const normalized = createMain({ schedule: STALE_AT_SCHEDULE });
    expect(normalized.schedule).toEqual(NORMALIZED_AT_SCHEDULE);
    expect(validateCronAddParams(normalized)).toBe(true);
  });
  it("prunes staggerMs from every schedules for create jobs", () => {
    const normalized = createMain({
      schedule: { kind: "every", everyMs: 60_000, staggerMs: 30_000 },
    });
    expect(normalized.schedule).toEqual(EVERY_SCHEDULE);
    expect(validateCronAddParams(normalized)).toBe(true);
  });
  it("normalizes string every schedule numbers for create jobs", () => {
    const normalized = createMain({
      schedule: { kind: "every", everyMs: "60000", anchorMs: "123.9" },
    });
    expect(normalized.schedule).toEqual({ ...EVERY_SCHEDULE, anchorMs: 123 });
    expect(validateCronAddParams(normalized)).toBe(true);
  });
  it("normalizes string every schedule numbers for patches", () => {
    const normalized = normalizePatch({
      schedule: { kind: "every", everyMs: "60000", anchorMs: "123.9" },
    });
    expect(normalized.schedule).toEqual({ ...EVERY_SCHEDULE, anchorMs: 123 });
    expect(validateCronUpdateParams({ id: "job", patch: normalized })).toBe(true);
    const nested = normalizePatch({
      delivery: { failureDestination: { channel: null, to: null, accountId: null, mode: null } },
    });
    expect(nested.delivery).toEqual({
      failureDestination: { channel: null, to: null, accountId: null, mode: null },
    });
    expect(validateCronUpdateParams({ id: "job", patch: nested })).toBe(true);
  });
  it("keeps invalid every schedule numbers invalid for validation", () => {
    const zeroEvery = createMain({ schedule: { kind: "every", everyMs: "0" } });
    const negativeAnchor = normalizePatch({
      schedule: { kind: "every", everyMs: "60000", anchorMs: "-1" },
    });
    expect(validateCronAddParams(zeroEvery)).toBe(false);
    expect(validateCronUpdateParams({ id: "job", patch: negativeAnchor })).toBe(false);
  });
  it("coerces sessionTarget and wakeMode casing", () => {
    const normalized = createAgent({ sessionTarget: " IsOlAtEd ", wakeMode: " NOW " });
    expect(normalized.sessionTarget).toBe("isolated");
    expect(normalized.wakeMode).toBe("now");
  });
  it("strips invalid delivery mode from partial delivery objects", () => {
    const delivery = child(
      createDefaulted(AGENT_TURN, {
        schedule: CRON_SCHEDULE,
        delivery: { mode: "bogus", to: "123" },
      }),
      "delivery",
    );
    expect(delivery.mode).toBeUndefined();
    expect(delivery.to).toBe("123");
  });
  it("stores current sessionTarget source context when context is available", () => {
    const normalized = createAgent({ sessionTarget: "current" }, "agent:main:discord:group:ops");
    expect(normalized.sessionTarget).toBe("current");
    expect(normalized.sessionKey).toBe("agent:main:discord:group:ops");
    expect(normalized.delivery).toEqual({ mode: "announce" });
  });
  it("falls back current sessionTarget to isolated without context", () => {
    const normalized = createAgent({ sessionTarget: "current" });
    expect(normalized.sessionTarget).toBe("isolated");
    expect(normalized.delivery).toEqual({ mode: "announce" });
  });
  it("preserves custom session ids with a session: prefix", () => {
    const normalized = createAgent({ sessionTarget: "session:MySessionID" });
    expect(normalized.sessionTarget).toBe("session:MySessionID");
    expect(normalized.delivery).toEqual({ mode: "announce" });
  });
  it("preserves custom session ids with channel-native separators", () => {
    const created = createAgent({
      sessionTarget: "session:agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==",
    });
    expect(created.sessionTarget).toBe(
      "session:agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==",
    );
    const patched = normalizePatch({ sessionTarget: "session:..\\outside" });
    expect(patched.sessionTarget).toBe("session:..\\outside");
  });
  it("rejects null bytes in custom session ids", () => {
    expect(() => createAgent({ sessionTarget: "session:bad\0id" })).toThrow(
      "invalid cron sessionTarget session id",
    );
  });
});
describe("normalizeCronJobPatch", () => {
  it("normalizes agentTurn model-only payload patches", () => {
    const { payload } = patchAgent({ model: "anthropic/claude-sonnet-4-6" });
    expect(payload.kind).toBe("agentTurn");
    expect(payload.model).toBe("anthropic/claude-sonnet-4-6");
  });
  it("preserves empty fallback lists so patches can disable fallbacks", () => {
    const { payload } = patchAgent({ fallbacks: [] });
    expect(payload.kind).toBe("agentTurn");
    expect(payload.fallbacks).toStrictEqual([]);
  });
  it("preserves empty toolsAllow lists so patches can disable all tools", () => {
    const { normalized, payload } = patchAgent({ toolsAllow: [] });
    expect(payload.kind).toBe("agentTurn");
    expect(payload.toolsAllow).toStrictEqual([]);
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });
  it("normalizes agentTurn fallback-only payload patches", () => {
    const { payload } = patchAgent({
      fallbacks: [" openrouter/gpt-4.1-mini ", "anthropic/claude-haiku-3-5"],
    });
    expect(payload.kind).toBe("agentTurn");
    expect(payload.fallbacks).toEqual(["openrouter/gpt-4.1-mini", "anthropic/claude-haiku-3-5"]);
  });
  it("drops malformed agentTurn fallback-only payload patches", () => {
    const { normalized, payload } = patchAgent({ fallbacks: [123] });
    expect(payload.kind).toBe("agentTurn");
    expect(payload.fallbacks).toBeUndefined();
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });
  it("normalizes agentTurn toolsAllow-only payload patches", () => {
    const { normalized, payload } = patchAgent({ toolsAllow: [" exec ", " read "] });
    expect(payload.kind).toBe("agentTurn");
    expect(payload.toolsAllow).toEqual(["exec", "read"]);
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });
  it("drops malformed agentTurn toolsAllow-only payload patches", () => {
    const { normalized, payload } = patchAgent({ toolsAllow: [123] });
    expect(payload.kind).toBe("agentTurn");
    expect(payload.toolsAllow).toBeUndefined();
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });
  it("preserves null toolsAllow so patches can clear the allow-list", () => {
    const { normalized, payload } = patchAgent({ toolsAllow: null });
    expect(payload.kind).toBe("agentTurn");
    expect(payload.toolsAllow).toBeNull();
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });
  it("preserves null fallback lists so patches can clear the fallback override", () => {
    const { normalized, payload } = patchAgent({ fallbacks: null });
    expect(payload.kind).toBe("agentTurn");
    expect(payload.fallbacks).toBeNull();
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });
  it("does not infer agentTurn from the shared toolsAllow field", () => {
    const normalized = normalizePatch({
      payload: { text: " continue the report ", toolsAllow: [" read "] },
    });
    expect(normalized.payload).toEqual({ text: "continue the report", toolsAllow: ["read"] });
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(false);
  });
  it("preserves null sessionKey patches and trims string values", () => {
    const trimmed = normalizePatch({ sessionKey: "  agent:main:telegram:group:-100123  " });
    const cleared = normalizePatch({ sessionKey: null });
    expect(trimmed.sessionKey).toBe("agent:main:telegram:group:-100123");
    expect(cleared.sessionKey).toBeNull();
  });
  it("preserves completion webhook patches without delivery mode", () => {
    const normalized = normalizePatch({
      delivery: {
        completionDestination: { mode: " WeBhOoK ", to: " https://example.invalid/complete " },
      },
    });
    expect(normalized.delivery).toEqual({
      completionDestination: { mode: "webhook", to: "https://example.invalid/complete" },
    });
    expect(validateCronUpdateParams({ id: "job", patch: normalized })).toBe(true);
  });
  it("preserves nullable delivery field clears in patches", () => {
    const normalized = normalizePatch({
      delivery: {
        channel: null,
        to: null,
        threadId: null,
        accountId: null,
        failureDestination: null,
      },
    });
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
    const normalized = normalizePatch({
      schedule: { kind: "cron", expr: "0 * * * *", staggerMs: "30000" },
    });
    expect(child(normalized, "schedule").staggerMs).toBe(30_000);
  });
  it("retains toolsAllow while pruning agentTurn-only fields from systemEvent patch payloads", () => {
    const normalized = normalizePatch({
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
    });
    expect(normalized.payload).toEqual({ kind: "systemEvent", text: "hi", toolsAllow: ["exec"] });
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });
  it("prunes schedule fields that do not belong to at schedules for patches", () => {
    const normalized = normalizePatch({ schedule: STALE_AT_SCHEDULE });
    expect(normalized.schedule).toEqual(NORMALIZED_AT_SCHEDULE);
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });
  it("prunes staggerMs from every schedules for patches", () => {
    const normalized = normalizePatch({
      schedule: { kind: "every", everyMs: 60_000, staggerMs: 30_000 },
    });
    expect(normalized.schedule).toEqual(EVERY_SCHEDULE);
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });
});
describe("on-exit schedule normalization", () => {
  it("keeps command/cwd and strips time fields for on-exit jobs", () => {
    const normalized = createMain({
      schedule: {
        kind: "on-exit",
        command: "make build",
        cwd: "/repo",
        everyMs: 1000,
        expr: "* * * * *",
        at: "2026-01-01T00:00:00Z",
      },
      payload: { kind: "systemEvent", text: "build done" },
    });
    expect(normalized).not.toBeNull();
    expect(normalized.schedule).toEqual({ kind: "on-exit", command: "make build", cwd: "/repo" });
    expect(validateCronAddParams(normalized)).toBe(true);
  });
  it("drops command/cwd when normalizing a non-on-exit schedule", () => {
    const normalized = createMain({
      schedule: { kind: "every", everyMs: 5000, command: "leftover", cwd: "/x" },
      payload: { kind: "systemEvent", text: "tick" },
    });
    expect(normalized).not.toBeNull();
    expect(child(normalized, "schedule")).not.toHaveProperty("command");
    expect(child(normalized, "schedule")).not.toHaveProperty("cwd");
  });
});
