import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { stableStringify } from "../agents/stable-stringify.js";
import {
  createRecoveryPointAcceptance,
  createRecoveryPointManifest,
  verifyRecoveryPoint,
  verifyRecoveryPointManifest,
  type RecoveryPointSqliteSnapshot,
} from "./recovery-point.js";
import type { SnapshotManifest, SnapshotRef, SqliteSnapshotProvider } from "./snapshot-provider.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((entry) => fs.rm(entry, { force: true, recursive: true })),
  );
});

describe("recovery point composition", () => {
  it("composes verified global and agent snapshots into one deterministic identity", async () => {
    const global = await createSnapshotFixture({ role: "global", userVersion: 7, byte: "a" });
    const agent = await createSnapshotFixture({
      role: "agent",
      agentId: "main",
      userVersion: 11,
      byte: "b",
    });
    const now = () => new Date("2026-07-21T16:00:00.000Z");
    const obligations = {
      external: [
        {
          id: "secret/provider-api-key",
          kind: "secret-ref",
          owner: "secrets",
          readinessRequired: true,
        },
      ],
      reconstructed: [
        {
          id: "plugin/optional-source",
          kind: "plugin-dependency",
          owner: "plugins",
          readinessRequired: false,
        },
      ],
    } as const;

    const first = await createRecoveryPointManifest({
      snapshots: [agent.snapshot, global.snapshot],
      expectedAgentIds: ["main"],
      obligations,
      now,
    });
    const second = await createRecoveryPointManifest({
      snapshots: [global.snapshot, agent.snapshot],
      expectedAgentIds: ["main"],
      obligations,
      now,
    });

    expect(first).toEqual(second);
    expect(first.recoveryPointId).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.inventory).toEqual({
      version: "openclaw-runtime-sqlite-inventory/v1",
      requiredComponentIds: ["sqlite/global", "sqlite/agent/main"],
    });
    expect(first.protection).toEqual({ mode: "host-protected" });
    expect(first.components.map((component) => component.id)).toEqual([
      "sqlite/global",
      "sqlite/agent/main",
    ]);
    expect(first.obligations.external).toEqual(obligations.external);
    expect(first.components.every((component) => component.ownerManifestSizeBytes > 0)).toBe(true);
    expect(createRecoveryPointAcceptance(first)).toEqual(createRecoveryPointAcceptance(second));
    expect(global.verify).toHaveBeenCalledTimes(4);
    expect(agent.verify).toHaveBeenCalledTimes(4);
  });

  it("re-verifies every owner snapshot against the aggregate manifest", async () => {
    const global = await createSnapshotFixture({ role: "global", userVersion: 7, byte: "a" });
    const agent = await createSnapshotFixture({
      role: "agent",
      agentId: "main",
      userVersion: 11,
      byte: "b",
    });
    const manifest = await createRecoveryPointManifest({
      snapshots: [global.snapshot, agent.snapshot],
      expectedAgentIds: ["main"],
      now: () => new Date("2026-07-21T16:00:00.000Z"),
    });

    await expect(
      verifyRecoveryPoint({
        manifest,
        snapshots: [agent.snapshot, global.snapshot],
        expectedAgentIds: ["main"],
      }),
    ).resolves.toEqual({ manifest, acceptance: createRecoveryPointAcceptance(manifest) });

    const mismatched = structuredClone(manifest);
    mismatched.components[1]!.artifactSha256 = "c".repeat(64);
    mismatched.recoveryPointId = recomputeIdentity(mismatched);
    await expect(
      verifyRecoveryPoint({
        manifest: mismatched,
        snapshots: [global.snapshot, agent.snapshot],
        expectedAgentIds: ["main"],
      }),
    ).rejects.toThrow("do not match the verified owner snapshots");
  });

  it("rejects reordered, duplicate, unknown, and secret-shaped metadata", async () => {
    const global = await createSnapshotFixture({ role: "global", userVersion: 7, byte: "a" });
    const agent = await createSnapshotFixture({
      role: "agent",
      agentId: "main",
      userVersion: 11,
      byte: "b",
    });
    const manifest = await createRecoveryPointManifest({
      snapshots: [global.snapshot, agent.snapshot],
      expectedAgentIds: ["main"],
      obligations: {
        external: [
          { id: "secret/z", kind: "secret-ref", owner: "secrets", readinessRequired: true },
          { id: "secret/a", kind: "secret-ref", owner: "secrets", readinessRequired: true },
        ],
      },
      now: () => new Date("2026-07-21T16:00:00.000Z"),
    });

    const reordered = structuredClone(manifest);
    reordered.components.reverse();
    reordered.recoveryPointId = recomputeIdentity(reordered);
    expect(() => verifyRecoveryPointManifest(reordered)).toThrow("canonical order");

    const reorderedObligations = structuredClone(manifest);
    reorderedObligations.obligations.external.reverse();
    reorderedObligations.recoveryPointId = recomputeIdentity(reorderedObligations);
    expect(() => verifyRecoveryPointManifest(reorderedObligations)).toThrow(
      "obligations are not in canonical order",
    );

    const invalidAgent = structuredClone(manifest);
    const agentComponent = invalidAgent.components[1];
    if (agentComponent?.kind !== "sqlite-agent") {
      throw new Error("expected agent component fixture");
    }
    agentComponent.agentId = "foo/bar";
    agentComponent.id = "sqlite/agent/foo/bar";
    invalidAgent.recoveryPointId = recomputeIdentity(invalidAgent);
    expect(() => verifyRecoveryPointManifest(invalidAgent)).toThrow("agent id is invalid");

    const duplicate = structuredClone(manifest);
    duplicate.components.push(structuredClone(duplicate.components[1]!));
    duplicate.recoveryPointId = recomputeIdentity(duplicate);
    expect(() => verifyRecoveryPointManifest(duplicate)).toThrow("duplicate component id");

    const unknown = structuredClone(manifest) as unknown as {
      components: Array<Record<string, unknown>>;
    };
    unknown.components[0]!.kind = "workspace";
    expect(() => verifyRecoveryPointManifest(unknown)).toThrow("manifest is invalid");

    const secretShaped = structuredClone(manifest) as unknown as {
      obligations: { external: Array<Record<string, unknown>> };
    };
    secretShaped.obligations.external.push({
      id: "secret/provider-api-key",
      kind: "secret-ref",
      owner: "secrets",
      readinessRequired: true,
      value: "must-not-appear",
    });
    expect(() => verifyRecoveryPointManifest(secretShaped)).toThrow("manifest is invalid");
  });

  it("rejects owner manifest byte rewrites during composition", async () => {
    const global = await createSnapshotFixture({ role: "global", userVersion: 7, byte: "a" });
    const agent = await createSnapshotFixture({
      role: "agent",
      agentId: "main",
      userVersion: 11,
      byte: "b",
    });
    global.verify.mockImplementationOnce(async () => ({
      ok: true as const,
      manifest: global.manifest,
    }));
    global.verify.mockImplementationOnce(async () => {
      await fs.writeFile(
        path.join(global.snapshot.ref.path, "manifest.json"),
        JSON.stringify(global.manifest),
        { mode: 0o600 },
      );
      return { ok: true as const, manifest: global.manifest };
    });

    await expect(
      createRecoveryPointManifest({
        snapshots: [global.snapshot, agent.snapshot],
        expectedAgentIds: ["main"],
      }),
    ).rejects.toThrow("changed during recovery-point composition");
  });

  it("rejects generic snapshots and incomplete SQLite inventories", async () => {
    const generic = await createSnapshotFixture({
      role: "generic",
      id: "custom",
      userVersion: 1,
      byte: "a",
    });
    await expect(
      createRecoveryPointManifest({ snapshots: [generic.snapshot], expectedAgentIds: ["main"] }),
    ).rejects.toThrow("Generic SQLite snapshots are not eligible");

    const global = await createSnapshotFixture({ role: "global", userVersion: 7, byte: "b" });
    await expect(
      createRecoveryPointManifest({ snapshots: [global.snapshot], expectedAgentIds: ["main"] }),
    ).rejects.toThrow("do not match the required inventory");
  });

  it("rejects incomplete, extra, and self-consistent but owner-mismatched inventories", async () => {
    const global = await createSnapshotFixture({ role: "global", userVersion: 7, byte: "a" });
    const main = await createSnapshotFixture({
      role: "agent",
      agentId: "main",
      userVersion: 11,
      byte: "b",
    });
    const research = await createSnapshotFixture({
      role: "agent",
      agentId: "research",
      userVersion: 12,
      byte: "c",
    });

    await expect(
      createRecoveryPointManifest({
        snapshots: [global.snapshot, main.snapshot],
        expectedAgentIds: ["main", "research"],
      }),
    ).rejects.toThrow("do not match the required inventory");
    await expect(
      createRecoveryPointManifest({
        snapshots: [global.snapshot, main.snapshot, research.snapshot],
        expectedAgentIds: ["main"],
      }),
    ).rejects.toThrow("do not match the required inventory");

    const manifest = await createRecoveryPointManifest({
      snapshots: [global.snapshot, main.snapshot],
      expectedAgentIds: ["main"],
    });
    await expect(
      verifyRecoveryPoint({
        manifest,
        snapshots: [global.snapshot, main.snapshot],
        expectedAgentIds: ["main", "research"],
      }),
    ).rejects.toThrow("does not match the state owner's expected agents");
  });

  it("rejects non-canonical dependency ordering", async () => {
    const global = await createSnapshotFixture({ role: "global", userVersion: 7, byte: "a" });
    const main = await createSnapshotFixture({
      role: "agent",
      agentId: "main",
      userVersion: 11,
      byte: "b",
    });
    const research = await createSnapshotFixture({
      role: "agent",
      agentId: "research",
      userVersion: 12,
      byte: "c",
    });
    const manifest = await createRecoveryPointManifest({
      snapshots: [global.snapshot, main.snapshot, research.snapshot],
      expectedAgentIds: ["main", "research"],
      now: () => new Date("2026-07-21T16:00:00.000Z"),
    });
    manifest.components[2]!.dependsOn = ["sqlite/global", "sqlite/agent/main"];
    manifest.recoveryPointId = recomputeIdentity(manifest);

    expect(() => verifyRecoveryPointManifest(manifest)).toThrow(
      "dependencies are not in canonical order",
    );
  });

  it("rejects unsupported obligation treatment, kind, and owner combinations", async () => {
    const global = await createSnapshotFixture({ role: "global", userVersion: 7, byte: "a" });
    const agent = await createSnapshotFixture({
      role: "agent",
      agentId: "main",
      userVersion: 11,
      byte: "b",
    });
    await expect(
      createRecoveryPointManifest({
        snapshots: [global.snapshot, agent.snapshot],
        expectedAgentIds: ["main"],
        obligations: {
          reconstructed: [
            {
              id: "secret/provider-api-key",
              kind: "secret-ref",
              owner: "secrets",
              readinessRequired: true,
            },
          ],
        },
      }),
    ).rejects.toThrow("unsupported treatment, kind, or owner");
  });
});

type SnapshotFixtureOptions =
  | { role: "global"; userVersion: number; byte: string }
  | { role: "agent"; agentId: string; userVersion: number; byte: string }
  | { role: "generic"; id: string; userVersion: number; byte: string };

async function createSnapshotFixture(options: SnapshotFixtureOptions): Promise<{
  snapshot: RecoveryPointSqliteSnapshot;
  manifest: SnapshotManifest;
  verify: Mock<SqliteSnapshotProvider["verify"]>;
}> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-recovery-point-"));
  tempRoots.push(rootPath);
  const snapshotPath = path.join(rootPath, "snapshot-1");
  await fs.mkdir(snapshotPath, { mode: 0o700 });
  const database =
    options.role === "global"
      ? { role: "global" as const, basename: "state.sqlite", userVersion: options.userVersion }
      : options.role === "agent"
        ? {
            role: "agent" as const,
            agentId: options.agentId,
            basename: "agent.sqlite",
            userVersion: options.userVersion,
          }
        : {
            role: "generic" as const,
            id: options.id,
            basename: "custom.sqlite",
            userVersion: options.userVersion,
          };
  const manifest: SnapshotManifest = {
    schemaVersion: 1,
    snapshotId: "snapshot-1",
    createdAt: "2026-07-21T15:00:00.000Z",
    database,
    artifact: {
      path: "database.sqlite",
      sha256: options.byte.repeat(64),
      sizeBytes: 1024,
    },
  };
  await fs.writeFile(
    path.join(snapshotPath, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  const verify = vi.fn<SqliteSnapshotProvider["verify"]>(async () => ({
    ok: true as const,
    manifest,
  }));
  const unsupported = async (): Promise<never> => {
    throw new Error("unsupported in recovery-point fixture");
  };
  const provider: SqliteSnapshotProvider = {
    create: unsupported,
    list: async () => [],
    restoreFresh: unsupported,
    verify,
  };
  const ref: SnapshotRef = { path: snapshotPath };
  return { snapshot: { provider, ref }, manifest, verify };
}

function recomputeIdentity(
  manifest: { recoveryPointId: string } & Record<string, unknown>,
): string {
  const { recoveryPointId: _recoveryPointId, ...withoutId } = manifest;
  return createHash("sha256").update(stableStringify(withoutId)).digest("hex");
}
