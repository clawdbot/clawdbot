import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildSessionStorageReadinessCondition,
  createSessionStorageReadinessEvidenceResolver,
  resolveSessionStorageDirectories,
} from "./session-storage.js";

describe("session storage readiness", () => {
  it("resolves the state root and deduplicated custom session-store parents", () => {
    const stateDir = path.resolve(os.tmpdir(), "openclaw-state");
    const storeRoot = path.resolve(os.tmpdir(), "openclaw-stores");
    const config = {
      agents: { list: [{ id: "main" }, { id: "support" }] },
      session: { store: path.join(storeRoot, "{agentId}", "sessions.json") },
    };

    expect(resolveSessionStorageDirectories(config, { OPENCLAW_STATE_DIR: stateDir })).toEqual(
      [stateDir, path.join(storeRoot, "main"), path.join(storeRoot, "support")].toSorted(),
    );
  });

  it("includes every configured agent's default session-store parent", () => {
    const stateDir = path.resolve(os.tmpdir(), "openclaw-state");

    expect(
      resolveSessionStorageDirectories(
        { agents: { list: [{ id: "main" }, { id: "support" }] } },
        { OPENCLAW_STATE_DIR: stateDir },
      ),
    ).toEqual(
      [
        stateDir,
        path.join(stateDir, "agents", "main", "sessions"),
        path.join(stateDir, "agents", "support", "sessions"),
      ].toSorted(),
    );
  });

  it("writes, flushes, and removes a probe in the state root", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-session-readiness-"));
    try {
      const evidence = await createSessionStorageReadinessEvidenceResolver()({
        config: {},
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(evidence).toMatchObject({ writable: true, reason: "SessionStorageReady" });
      expect(await readdir(stateDir)).toEqual([]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("fails when a configured session-store parent is missing", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-session-readiness-"));
    try {
      const missingParent = path.join(stateDir, "missing", "sessions.json");
      const evidence = await createSessionStorageReadinessEvidenceResolver()({
        config: { session: { store: missingParent } },
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(evidence).toMatchObject({ writable: false, reason: "SessionStorageMissing" });
      expect(evidence.message).not.toContain(stateDir);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("times out without starting overlapping probes", async () => {
    let releaseProbe:
      | ((value: { writable: true; reason: string; message: string }) => void)
      | null = null;
    const probe = vi.fn(
      () =>
        new Promise<{ writable: true; reason: string; message: string }>((resolve) => {
          releaseProbe = resolve;
        }),
    );
    const resolve = createSessionStorageReadinessEvidenceResolver({
      cacheTtlMs: 1_000,
      probeTimeoutMs: 5,
      probe,
    });
    const stateDir = path.resolve(os.tmpdir(), "openclaw-state");
    const params = {
      config: { session: { store: path.join(stateDir, "sessions.json") } },
      env: { OPENCLAW_STATE_DIR: stateDir },
    };

    const [first, second] = await Promise.all([resolve(params), resolve(params)]);
    expect(first).toMatchObject({ writable: null, reason: "SessionStorageProbeTimedOut" });
    expect(second).toMatchObject({ writable: null, reason: "SessionStorageProbeTimedOut" });
    expect(probe).toHaveBeenCalledTimes(1);

    releaseProbe?.({
      writable: true,
      reason: "SessionStorageReady",
      message: "ready",
    });
    await new Promise<void>((resolvePending) => {
      setTimeout(resolvePending, 0);
    });
    await expect(resolve(params)).resolves.toMatchObject({ writable: true });
  });

  it("fails closed when the configured path set exceeds its bound", async () => {
    const agents = Array.from({ length: 65 }, (_, index) => ({ id: `agent-${index}` }));
    const resolve = createSessionStorageReadinessEvidenceResolver({
      probe: vi.fn(async () => ({
        writable: true,
        reason: "SessionStorageReady",
        message: "ready",
      })),
    });

    await expect(
      resolve({
        config: {
          agents: { list: agents },
          session: { store: "/stores/{agentId}/sessions.json" },
        },
        env: { OPENCLAW_STATE_DIR: "/state" },
      }),
    ).resolves.toMatchObject({
      writable: null,
      reason: "SessionStoragePathLimitExceeded",
    });
  });

  it("caps concurrent storage probes", async () => {
    const probe = vi.fn(() => new Promise<never>(() => {}));
    const resolve = createSessionStorageReadinessEvidenceResolver({
      probeTimeoutMs: 5,
      probe,
    });

    await expect(
      resolve({
        config: {
          agents: {
            list: Array.from({ length: 5 }, (_, index) => ({ id: `agent-${index}` })),
          },
          session: { store: "/stores/{agentId}/sessions.json" },
        },
        env: { OPENCLAW_STATE_DIR: "/state" },
      }),
    ).resolves.toMatchObject({ reason: "SessionStorageProbeTimedOut" });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("does not publish evidence from a retired config generation", async () => {
    const releases: Array<(evidence: { writable: true; reason: string; message: string }) => void> =
      [];
    const probe = vi.fn(
      () =>
        new Promise<{ writable: true; reason: string; message: string }>((resolve) => {
          releases.push(resolve);
        }),
    );
    const resolve = createSessionStorageReadinessEvidenceResolver({
      probeTimeoutMs: 500,
      probe,
    });
    const firstConfig = { session: { store: "/stores/first/sessions.json" } };
    const nextConfig = { session: { store: "/stores/next/sessions.json" } };
    const first = resolve({ config: firstConfig, env: { OPENCLAW_STATE_DIR: "/state" } });
    const next = resolve({ config: nextConfig, env: { OPENCLAW_STATE_DIR: "/state" } });

    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(4));
    releases[0]?.({ writable: true, reason: "SessionStorageReady", message: "retired" });
    releases[1]?.({ writable: true, reason: "SessionStorageReady", message: "retired" });
    releases[2]?.({ writable: true, reason: "SessionStorageReady", message: "ready" });
    releases[3]?.({ writable: true, reason: "SessionStorageReady", message: "ready" });

    await expect(first).resolves.toMatchObject({ reason: "SessionStorageNotChecked" });
    await expect(next).resolves.toMatchObject({ reason: "SessionStorageReady" });
  });

  it("bounds detached probe groups across repeated config generations", async () => {
    const probe = vi.fn(() => new Promise<never>(() => {}));
    const resolve = createSessionStorageReadinessEvidenceResolver({
      cacheTtlMs: 0,
      probeTimeoutMs: 5,
      probe,
    });
    const evidence = (name: string) =>
      resolve({
        config: { session: { store: `/stores/${name}/sessions.json` } },
        env: { OPENCLAW_STATE_DIR: "/state" },
      });

    await expect(evidence("first")).resolves.toMatchObject({
      reason: "SessionStorageProbeTimedOut",
    });
    await expect(evidence("second")).resolves.toMatchObject({
      reason: "SessionStorageProbeTimedOut",
    });
    await expect(evidence("third")).resolves.toMatchObject({
      reason: "SessionStorageProbeTimedOut",
      message: "Prior session storage probes still occupy the bounded probe capacity.",
    });
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it("maps evidence to the canonical condition", () => {
    expect(
      buildSessionStorageReadinessCondition({
        writable: false,
        reason: "SessionStorageFull",
        message: "storage is full",
      }),
    ).toMatchObject({
      type: "SessionStorageReady",
      status: "False",
      requirement: "advisory",
      reason: "SessionStorageFull",
    });
  });
});
