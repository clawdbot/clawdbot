import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUpdateRun, finishUpdateRun } from "../../infra/update-run-ledger.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";
import { updateStatusHandlers } from "./update-status.js";

vi.mock("../../infra/update-startup.js", () => ({
  getUpdateAvailable: () => null,
  getUpdateSchedule: () => null,
  getUpdateEffectiveChannel: async () => "stable",
  refreshGatewayUpdateStatus: async () => {},
}));

vi.mock("../server-restart-sentinel.js", () => ({
  getLatestUpdateRestartSentinel: () => null,
  refreshLatestUpdateRestartSentinel: async () => null,
}));

type UpdateReadMethod = "update.status" | "update.runs.get" | "update.runs.list";

async function requestUpdateRead(method: UpdateReadMethod, params: Record<string, unknown> = {}) {
  const respond = vi.fn<RespondFn>();
  await expectDefined(
    updateStatusHandlers[method],
    method,
  )({
    req: { type: "req", id: method, method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {
      getRuntimeConfig: () => ({ update: { channel: "stable" } }),
    } as GatewayRequestContext,
  });
  return respond;
}

let home: TempHomeEnv;
beforeEach(async () => {
  home = await createTempHomeEnv("openclaw-update-status-");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await home.restore();
});

describe("update history RPCs", () => {
  it("projects distinct active and latest runs and reads persisted history in creation order", async () => {
    expect(await requestUpdateRead("update.status")).toHaveBeenCalledWith(true, {
      sentinel: null,
      updateAvailable: null,
      effectiveChannel: "stable",
    });
    expect(await requestUpdateRead("update.runs.list")).toHaveBeenCalledWith(true, { runs: [] });

    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const active = createUpdateRun({ trigger: "api" });
    now.mockReturnValue(2_000);
    const latest = finishUpdateRun(createUpdateRun({ trigger: "cli" }).runId, {
      status: "skipped",
      reason: "dry-run",
    });
    expect(await requestUpdateRead("update.status")).toHaveBeenCalledWith(true, {
      sentinel: null,
      activeRun: active,
      lastRun: latest,
      updateAvailable: null,
      effectiveChannel: "stable",
    });
    expect(
      await requestUpdateRead("update.runs.get", { runId: active.runId }),
    ).toHaveBeenCalledWith(true, { run: active });
    expect(
      await requestUpdateRead("update.runs.get", { runId: randomUUID() }),
    ).toHaveBeenCalledWith(true, { run: null });

    now.mockReturnValue(3_000);
    const completed = finishUpdateRun(active.runId, { status: "succeeded" });
    expect(await requestUpdateRead("update.status")).toHaveBeenCalledWith(true, {
      sentinel: null,
      lastRun: latest,
      updateAvailable: null,
      effectiveChannel: "stable",
    });
    expect(await requestUpdateRead("update.runs.list")).toHaveBeenCalledWith(true, {
      runs: [latest, completed],
    });
    expect(await requestUpdateRead("update.runs.list", { limit: 1 })).toHaveBeenCalledWith(true, {
      runs: [latest],
    });
  });

  it("rejects malformed identities, invalid limits, and unsupported query fields", async () => {
    createUpdateRun({ trigger: "api" });
    const invalidRequests: Array<[UpdateReadMethod, Record<string, unknown>]> = [
      ["update.runs.get", {}],
      ["update.runs.get", { runId: "not-a-uuid" }],
      ["update.runs.list", { limit: 0 }],
      ["update.runs.list", { limit: 101 }],
      ["update.runs.list", { limit: 1.5 }],
      ["update.runs.list", { active: true }],
      ["update.status", { runId: randomUUID() }],
    ];
    for (const [method, params] of invalidRequests) {
      const respond = await requestUpdateRead(method, params);
      expect(respond, `${method}: ${JSON.stringify(params)}`).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    }
  });
});
