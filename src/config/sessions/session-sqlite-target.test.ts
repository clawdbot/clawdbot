import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

describe("resolveSqliteTargetFromSessionStorePath", () => {
  it("keeps custom store targets distinct when templates share a directory", () => {
    const dir = path.join("tmp", "stores");

    expect(resolveSqliteTargetFromSessionStorePath(path.join(dir, "main.json"))).toMatchObject({
      path: path.resolve(dir, "main.sqlite"),
    });
    expect(resolveSqliteTargetFromSessionStorePath(path.join(dir, "worker.json"))).toMatchObject({
      path: path.resolve(dir, "worker.sqlite"),
    });
  });

  it("keeps shared custom store targets distinct by agent", () => {
    const storePath = path.join("tmp", "stores", "shared-sessions.json");

    expect(resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" })).toMatchObject({
      path: path.resolve("tmp", "stores", "shared-sessions.sqlite"),
    });
    expect(resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "work" })).toMatchObject({
      path: path.resolve("tmp", "stores", "shared-sessions.work.sqlite"),
    });
  });

  it("keeps a basename matching a non-main id distinct from main", () => {
    const storePath = path.join("tmp", "stores", "ops.json");

    expect(resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path).toBe(
      path.resolve("tmp", "stores", "ops.sqlite"),
    );
    expect(resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "ops" }).path).toBe(
      path.resolve("tmp", "stores", "ops.ops.sqlite"),
    );
  });

  it("keeps shared custom sessions.json targets distinct by agent", () => {
    const storePath = path.join("tmp", "stores", "sessions.json");

    expect(resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" })).toMatchObject({
      path: path.resolve("tmp", "stores", "openclaw-agent.sqlite"),
    });
    expect(resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "work" })).toMatchObject({
      path: path.resolve("tmp", "stores", "openclaw-agent.work.sqlite"),
    });
  });
});
