import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  acquireFleetCellOperation,
  deleteFleetCell,
  getFleetCell,
  listFleetCells,
  reserveFleetCell,
  updateFleetCellImage,
} from "./registry.js";

type ReserveFleetCellParams = Parameters<typeof reserveFleetCell>[1];

describe("fleet cell registry", () => {
  let root: string | undefined;
  let env: NodeJS.ProcessEnv;

  const tempRoot = createSuiteTempRootTracker({ prefix: "openclaw-fleet-registry-" });

  beforeEach(async () => {
    root = await tempRoot.setup();
    env = { ...process.env, OPENCLAW_STATE_DIR: root };
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await tempRoot.cleanup();
    root = undefined;
  });

  function params(tenantId: string, requestedPort?: number): ReserveFleetCellParams {
    if (!root) {
      throw new Error("test root not initialized");
    }
    return {
      tenantId,
      createdAtMs: 1,
      image: "ghcr.io/openclaw/openclaw:latest",
      runtime: "docker",
      containerName: `openclaw-cell-${tenantId}`,
      dataDir: path.join(root, "fleet", "cells", tenantId),
      ...(requestedPort === undefined ? {} : { requestedPort }),
    };
  }

  it("persists, orders, updates, and deletes cells", () => {
    const zulu = reserveFleetCell(env, {
      ...params("zulu", 19_250),
      createdAtMs: 20,
      runtime: "podman",
    });
    const alpha = reserveFleetCell(env, {
      ...params("alpha"),
      createdAtMs: 10,
    });

    expect(alpha.hostPort).toBe(19_100);
    expect(zulu.hostPort).toBe(19_250);
    expect(listFleetCells(env).map((cell) => cell.tenantId)).toEqual(["alpha", "zulu"]);
    expect(getFleetCell(env, "zulu")).toEqual(zulu);

    updateFleetCellImage(env, "zulu", "ghcr.io/openclaw/openclaw:v2");
    expect(getFleetCell(env, "zulu")?.image).toBe("ghcr.io/openclaw/openclaw:v2");

    deleteFleetCell(env, "alpha");
    expect(getFleetCell(env, "alpha")).toBeUndefined();
  });

  it("rejects duplicate tenant ids without replacing the row", () => {
    const original = reserveFleetCell(env, params("alpha", 19_300));

    expect(() =>
      reserveFleetCell(env, {
        ...params("alpha", 19_301),
        image: "ghcr.io/openclaw/openclaw:other",
      }),
    ).toThrow("Fleet cell already exists: alpha");
    expect(getFleetCell(env, "alpha")).toEqual(original);
  });

  it("allocates the first free port and rejects explicit collisions", () => {
    expect(reserveFleetCell(env, params("alpha")).hostPort).toBe(19_100);
    expect(reserveFleetCell(env, params("beta")).hostPort).toBe(19_101);

    expect(() => reserveFleetCell(env, params("gamma", 19_100))).toThrow(/19100/);
    expect(getFleetCell(env, "gamma")).toBeUndefined();
    expect(reserveFleetCell(env, params("delta", 20_000)).hostPort).toBe(20_000);
  });

  it("serializes tenant mutations with renewable expiring leases", () => {
    const first = acquireFleetCellOperation({
      env,
      tenantId: "alpha",
      operation: "upgrade",
      owner: "first",
      nowMs: 1_000,
    });

    expect(() =>
      acquireFleetCellOperation({
        env,
        tenantId: "alpha",
        operation: "rm",
        owner: "second",
        nowMs: 1_001,
      }),
    ).toThrow(/fleet upgrade.*already running/iu);

    first.heartbeat(200_000);
    expect(() =>
      acquireFleetCellOperation({
        env,
        tenantId: "alpha",
        operation: "rm",
        owner: "second",
        nowMs: 400_000,
      }),
    ).toThrow(/already running/iu);

    first.release();
    const second = acquireFleetCellOperation({
      env,
      tenantId: "alpha",
      operation: "rm",
      owner: "second",
      nowMs: 400_001,
    });
    second.release();
  });

  it("fences an expired owner from its replacement lease", () => {
    const first = acquireFleetCellOperation({
      env,
      tenantId: "alpha",
      operation: "upgrade",
      owner: "first",
      nowMs: 1_000,
    });
    const successor = acquireFleetCellOperation({
      env,
      tenantId: "alpha",
      operation: "rm",
      owner: "successor",
      nowMs: 301_000,
    });

    expect(() => first.heartbeat(301_001)).toThrow(/lease was lost/iu);
    first.release();
    expect(() =>
      acquireFleetCellOperation({
        env,
        tenantId: "alpha",
        operation: "create",
        owner: "third",
        nowMs: 301_002,
      }),
    ).toThrow(/fleet rm.*already running/iu);

    successor.release();
  });

  it("fails image updates when the cell row disappeared", () => {
    expect(() => updateFleetCellImage(env, "missing", "image:v2")).toThrow(/disappeared/iu);
  });
});
