// Cron tokenBudget normalizer+validator tests cover per-job agentTurn budget caps.
import { describe, expect, it } from "vitest";
import {
  validateCronAddParams,
  validateCronUpdateParams,
} from "../../packages/gateway-protocol/src/index.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "./normalize.js";

type UnknownRecord = Record<string, unknown>;

const CRON_SCHEDULE = { kind: "cron", expr: "* * * * *" };
const AGENT_TURN_BASE = { kind: "agentTurn", message: "hello" };
const COMMAND_BASE = { kind: "command", argv: ["sh", "-lc", "echo ok"] };
const SCRIPT_BASE = { kind: "script", script: "echo ok" };

function normalizeCreate(raw: UnknownRecord): UnknownRecord {
  return normalizeCronJobCreate(raw) as unknown as UnknownRecord;
}

function normalizePatch(raw: UnknownRecord): UnknownRecord {
  return normalizeCronJobPatch(raw) as unknown as UnknownRecord;
}

function createWith(payload: UnknownRecord): UnknownRecord {
  return normalizeCreate({
    name: "test",
    schedule: CRON_SCHEDULE,
    sessionTarget: "isolated",
    wakeMode: "now",
    payload,
  });
}

type PatchParams = { id: string; patch: { payload: UnknownRecord } };

function patchParams(payload: UnknownRecord): PatchParams {
  return { id: "job-1", patch: normalizePatch({ payload }) } as PatchParams;
}

describe("tokenBudget protocol+normalizer end-to-end", () => {
  describe("create (validateCronAddParams)", () => {
    it("accepts a positive integer tokenBudget on agentTurn payload", () => {
      const job = createWith({ ...AGENT_TURN_BASE, tokenBudget: 8000 });
      expect(job.payload).toMatchObject({ kind: "agentTurn", tokenBudget: 8000 });
      expect(validateCronAddParams(job)).toBe(true);
    });

    it("accepts minimum valid tokenBudget (1)", () => {
      const job = createWith({ ...AGENT_TURN_BASE, tokenBudget: 1 });
      expect(job.payload).toMatchObject({ kind: "agentTurn", tokenBudget: 1 });
      expect(validateCronAddParams(job)).toBe(true);
    });

    it("accepts omission of tokenBudget (Unlimited)", () => {
      const job = createWith({ ...AGENT_TURN_BASE });
      expect(job.payload).not.toHaveProperty("tokenBudget");
      expect(validateCronAddParams(job)).toBe(true);
    });

    // Invalid values are silently dropped by the normalizer before validation.
    it("drops zero tokenBudget (normalizer strips, validator passes)", () => {
      const job = createWith({ ...AGENT_TURN_BASE, tokenBudget: 0 });
      expect(job.payload).not.toHaveProperty("tokenBudget");
      expect(validateCronAddParams(job)).toBe(true);
    });

    it("drops negative tokenBudget (normalizer strips, validator passes)", () => {
      const job = createWith({ ...AGENT_TURN_BASE, tokenBudget: -5 });
      expect(job.payload).not.toHaveProperty("tokenBudget");
      expect(validateCronAddParams(job)).toBe(true);
    });

    it("drops fractional tokenBudget (normalizer strips, validator passes)", () => {
      const job = createWith({ ...AGENT_TURN_BASE, tokenBudget: 8000.5 });
      expect(job.payload).not.toHaveProperty("tokenBudget");
      expect(validateCronAddParams(job)).toBe(true);
    });

    it("drops NaN tokenBudget (normalizer strips, validator passes)", () => {
      const job = createWith({ ...AGENT_TURN_BASE, tokenBudget: Number.NaN });
      expect(job.payload).not.toHaveProperty("tokenBudget");
      expect(validateCronAddParams(job)).toBe(true);
    });

    it("drops string tokenBudget (normalizer strips, validator passes)", () => {
      const job = createWith({ ...AGENT_TURN_BASE, tokenBudget: "8000" });
      expect(job.payload).not.toHaveProperty("tokenBudget");
      expect(validateCronAddParams(job)).toBe(true);
    });

    it("rejects null tokenBudget on create (not a valid create shape)", () => {
      // null is not a valid create value — normalizer preserves null but
      // the create schema rejects it (only Integer({minimum:1} accepted)
      const job = createWith({ ...AGENT_TURN_BASE, tokenBudget: null });
      expect(validateCronAddParams(job)).toBe(false);
    });
  });

  describe("patch (validateCronUpdateParams)", () => {
    it("accepts a positive integer tokenBudget on agentTurn patch", () => {
      const params = patchParams({ kind: "agentTurn", tokenBudget: 12_345 });
      expect(params.patch.payload).toMatchObject({ kind: "agentTurn", tokenBudget: 12_345 });
      expect(validateCronUpdateParams(params)).toBe(true);
    });

    it("accepts explicit null tokenBudget to clear a stored value", () => {
      const params = patchParams({ kind: "agentTurn", tokenBudget: null });
      expect(params.patch.payload).toMatchObject({ kind: "agentTurn", tokenBudget: null });
      expect(validateCronUpdateParams(params)).toBe(true);
    });

    it("accepts omission (no field touched)", () => {
      const params = patchParams({ kind: "agentTurn" });
      expect(params.patch.payload).not.toHaveProperty("tokenBudget");
      expect(validateCronUpdateParams(params)).toBe(true);
    });

    // Invalid values are silently dropped by the normalizer.
    it("drops zero tokenBudget on patch (normalizer strips)", () => {
      const params = patchParams({ kind: "agentTurn", tokenBudget: 0 });
      expect(params.patch.payload).not.toHaveProperty("tokenBudget");
      expect(validateCronUpdateParams(params)).toBe(true);
    });

    it("drops negative tokenBudget on patch (normalizer strips)", () => {
      const params = patchParams({ kind: "agentTurn", tokenBudget: -1 });
      expect(params.patch.payload).not.toHaveProperty("tokenBudget");
      expect(validateCronUpdateParams(params)).toBe(true);
    });

    it("drops NaN tokenBudget on patch (normalizer strips)", () => {
      const params = patchParams({ kind: "agentTurn", tokenBudget: Number.NaN });
      expect(params.patch.payload).not.toHaveProperty("tokenBudget");
      expect(validateCronUpdateParams(params)).toBe(true);
    });
  });

  describe("normalizer merge behavior", () => {
    it("passes through a valid tokenBudget without modification", () => {
      const { payload: p } = normalizePatch({
        payload: { kind: "agentTurn", tokenBudget: 4096 },
      }) as { payload: UnknownRecord };
      expect(p.tokenBudget).toBe(4096);
    });

    it("drops invalid tokenBudget silently (does not throw, does not keep value)", () => {
      const { payload: p } = normalizePatch({
        payload: { kind: "agentTurn", tokenBudget: -100 },
      }) as { payload: UnknownRecord };
      expect(p).not.toHaveProperty("tokenBudget");
    });

    it("preserves an explicit null tokenBudget for clear-on-patch semantics", () => {
      const { payload: p } = normalizePatch({
        payload: { kind: "agentTurn", tokenBudget: null },
      }) as { payload: UnknownRecord };
      expect(p.tokenBudget).toBeNull();
    });

    it("drops NaN tokenBudget silently", () => {
      const { payload: p } = normalizePatch({
        payload: { kind: "agentTurn", tokenBudget: Number.NaN },
      }) as { payload: UnknownRecord };
      expect(p).not.toHaveProperty("tokenBudget");
    });
  });

  describe("payload-kind isolation", () => {
    it("strips tokenBudget from command payloads (not a command field)", () => {
      const job = createWith({ ...COMMAND_BASE, tokenBudget: 1000 });
      expect(job.payload).not.toHaveProperty("tokenBudget");
      expect(validateCronAddParams(job)).toBe(true);
    });

    it("strips tokenBudget from script payloads (not a script field)", () => {
      const job = createWith({ ...SCRIPT_BASE, tokenBudget: 1000 });
      expect(job.payload).not.toHaveProperty("tokenBudget");
      expect(validateCronAddParams(job)).toBe(true);
    });

    it("strips tokenBudget from systemEvent payloads (not a systemEvent field)", () => {
      const job = createWith({
        kind: "systemEvent",
        text: "tick",
        tokenBudget: 1000,
      });
      expect(job.payload).not.toHaveProperty("tokenBudget");
      expect(validateCronAddParams(job)).toBe(true);
    });

    it("preserves tokenBudget only on agentTurn payloads", () => {
      const job = createWith({ ...AGENT_TURN_BASE, tokenBudget: 2048 });
      expect(job.payload).toMatchObject({ kind: "agentTurn", tokenBudget: 2048 });
      expect(validateCronAddParams(job)).toBe(true);
    });
  });

  describe("kind inference from bare tokenBudget", () => {
    it("infers agentTurn kind when only tokenBudget is supplied alongside text", () => {
      const job = normalizeCreate({
        name: "test",
        schedule: CRON_SCHEDULE,
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { text: "tick", tokenBudget: 512 },
      });
      expect(job.payload).toMatchObject({ kind: "agentTurn", tokenBudget: 512 });
      expect(validateCronAddParams(job)).toBe(true);
    });
  });
});
