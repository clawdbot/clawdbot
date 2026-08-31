import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

describe("resolveSqliteTargetFromSessionStorePath", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  it("assigns a new exact SQLite locator to the configured default without caller capture", () => {
    const databasePath = path.resolve("tmp", "stores", "new-shared.sqlite");

    expect(
      resolveSqliteTargetFromSessionStorePath(databasePath, {
        agentId: "worker",
        defaultAgentId: "ops",
      }),
    ).toMatchObject({
      agentId: "ops",
      ownerSource: "configured-default",
      path: databasePath,
      shared: true,
    });
  });

  it("keeps a multiply registered exact SQLite locator shared", () => {
    const databasePath = path.resolve("tmp", "stores", "existing-shared.sqlite");

    expect(
      resolveSqliteTargetFromSessionStorePath(databasePath, {
        defaultAgentId: "main",
        registeredDatabases: [
          { agentId: "main", path: databasePath },
          { agentId: "ops", path: databasePath },
        ],
      }),
    ).toMatchObject({
      agentId: "main",
      ownerSource: "ambiguous-registry",
      path: databasePath,
      shared: true,
    });
  });

  it("keeps an incognito sentinel owned by its requested agent", () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-incognito-target-") };
    const databasePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "ops", env });

    expect(
      resolveSqliteTargetFromSessionStorePath(databasePath, {
        agentId: "ops",
        defaultAgentId: "main",
        env,
      }),
    ).toEqual({ agentId: "ops", path: databasePath });
  });

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

  it("keeps basename-matching non-owners on a distinct suffixed target", () => {
    const storePath = path.join("tmp", "stores", "ops.json");

    expect(resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path).toBe(
      path.resolve("tmp", "stores", "ops.sqlite"),
    );
    expect(
      resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "ops",
        defaultAgentId: "main",
      }).path,
    ).toBe(path.resolve("tmp", "stores", "ops.ops.sqlite"));
  });

  it("lets the registered owner retain the unsuffixed target", () => {
    const storePath = path.join("tmp", "stores", "ops.json");

    expect(
      resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "ops",
        defaultAgentId: "main",
        registeredDatabases: [
          { agentId: "ops", path: path.resolve("tmp", "stores", "ops.sqlite") },
        ],
      }).path,
    ).toBe(path.resolve("tmp", "stores", "ops.sqlite"));
    expect(
      resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "main",
        defaultAgentId: "main",
        registeredDatabases: [
          { agentId: "ops", path: path.resolve("tmp", "stores", "ops.sqlite") },
        ],
      }).path,
    ).toBe(path.resolve("tmp", "stores", "ops.main.sqlite"));
  });

  it("skips a conventional suffix persisted for another owner", () => {
    const storePath = path.join("tmp", "stores", "shared.json");
    const occupiedPath = path.resolve("tmp", "stores", "shared.worker.sqlite");

    expect(
      resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "worker",
        defaultAgentId: "main",
        registeredDatabases: [{ agentId: "ops", path: occupiedPath }],
      }).path,
    ).toBe(path.resolve("tmp", "stores", "shared.worker.2.sqlite"));
  });

  it("does not treat ambiguous suffix registration as ownership", () => {
    const storePath = path.join("tmp", "stores", "shared.json");
    const ambiguousPath = path.resolve("tmp", "stores", "shared.worker.sqlite");

    expect(
      resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "worker",
        defaultAgentId: "main",
        registeredDatabases: [
          { agentId: "worker", path: ambiguousPath },
          { agentId: "ops", path: ambiguousPath },
        ],
      }).path,
    ).toBe(path.resolve("tmp", "stores", "shared.worker.2.sqlite"));
  });

  it("does not assign an ambiguously registered unsuffixed target to the default", () => {
    const storePath = path.join("tmp", "stores", "shared.json");
    const unsuffixedPath = path.resolve("tmp", "stores", "shared.sqlite");

    expect(
      resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "main",
        defaultAgentId: "main",
        registeredDatabases: [
          { agentId: "main", path: unsuffixedPath },
          { agentId: "ops", path: unsuffixedPath },
        ],
      }).path,
    ).toBe(path.resolve("tmp", "stores", "shared.main.sqlite"));
  });

  it("searches past every occupied suffix for the first free target", () => {
    const storePath = path.join("tmp", "stores", "shared.json");
    const registeredDatabases = Array.from({ length: 33 }, (_, offset) => {
      const index = offset + 1;
      const fileName = index === 1 ? "shared.worker.sqlite" : `shared.worker.${index}.sqlite`;
      return { agentId: "ops", path: path.resolve("tmp", "stores", fileName) };
    });

    expect(
      resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "worker",
        defaultAgentId: "main",
        registeredDatabases,
      }).path,
    ).toBe(path.resolve("tmp", "stores", "shared.worker.34.sqlite"));
  });

  it("ignores a sparse huge suffix when the conventional suffix is free", () => {
    const storePath = path.join("tmp", "stores", "shared.json");

    expect(
      resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "worker",
        defaultAgentId: "main",
        registeredDatabases: [
          {
            agentId: "ops",
            path: path.resolve("tmp", "stores", "shared.worker.2147483647.sqlite"),
          },
        ],
      }).path,
    ).toBe(path.resolve("tmp", "stores", "shared.worker.sqlite"));
  });

  it("does not treat noncanonical numeric suffix spellings as occupied indices", () => {
    const storePath = path.join("tmp", "stores", "shared.json");

    expect(
      resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "worker",
        defaultAgentId: "main",
        registeredDatabases: [
          {
            agentId: "ops",
            path: path.resolve("tmp", "stores", "shared.worker.sqlite"),
          },
          {
            agentId: "ops",
            path: path.resolve("tmp", "stores", "shared.worker.02.sqlite"),
          },
        ],
      }).path,
    ).toBe(path.resolve("tmp", "stores", "shared.worker.2.sqlite"));
  });

  it.runIf(process.platform !== "win32")("treats dangling suffix symlinks as occupied", () => {
    const dir = tempDirs.make("openclaw-session-suffix-symlink-");
    const storePath = path.join(dir, "shared.json");
    fs.symlinkSync(path.join(dir, "missing-target.sqlite"), path.join(dir, "shared.worker.sqlite"));

    expect(
      resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "worker",
        defaultAgentId: "main",
      }).path,
    ).toBe(path.join(dir, "shared.worker.2.sqlite"));
  });

  it.runIf(process.platform !== "win32")(
    "does not assign a dangling unsuffixed symlink to the default",
    () => {
      const dir = tempDirs.make("openclaw-session-unsuffixed-symlink-");
      const storePath = path.join(dir, "shared.json");
      fs.symlinkSync(path.join(dir, "missing-target.sqlite"), path.join(dir, "shared.sqlite"));

      expect(
        resolveSqliteTargetFromSessionStorePath(storePath, {
          agentId: "main",
          defaultAgentId: "main",
        }).path,
      ).toBe(path.join(dir, "shared.main.sqlite"));
    },
  );

  it("propagates non-missing target-directory inspection errors", () => {
    const dir = tempDirs.make("openclaw-session-suffix-inspection-");
    const blocker = path.join(dir, "not-a-directory");
    fs.writeFileSync(blocker, "blocked\n");

    expect(() =>
      resolveSqliteTargetFromSessionStorePath(path.join(blocker, "shared.json"), {
        agentId: "worker",
        defaultAgentId: "main",
      }),
    ).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
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
