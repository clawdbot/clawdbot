import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpxRuntime, createAgentRegistry, createFileSessionStore } from "acpx/runtime";
import { expect, it } from "vitest";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { createPluginDoctorStateMigrationContext } from "../../infra/state-migrations.plugin-doctor-context.js";
import { resolvePluginDoctorContractArtifactPath } from "../../plugins/doctor-contract-artifact.js";
import {
  coercePluginDoctorContractModule,
  type PluginDoctorContractModule,
} from "../../plugins/doctor-contract-module.js";
import { getCachedPluginModuleLoader } from "../../plugins/plugin-module-loader-cache.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readAcpSessionMeta, upsertAcpSessionMeta } from "./session-meta.js";

it("inspects without creating state and conditionally updates only the proven current owner", async () => {
  await withOpenClawTestState({ label: "acp-doctor-owner" }, async ({ env, stateDir }) => {
    const cfg = {
      agents: { ownership: "explicit" as const, entries: { main: {}, work: {} } },
      session: { scope: "global" as const },
    };
    const scope = { pluginId: "acpx", config: cfg, env };
    const readOnly = createPluginDoctorStateMigrationContext(scope);
    expect(readOnly.updateAcpSessionIdentity).toBeUndefined();
    expect(await readOnly.inspectAcpSessionClaims!()).toEqual({ claims: [], incomplete: [] });
    await expect(fs.access(path.join(stateDir, "state", "openclaw.sqlite"))).rejects.toThrow();
    for (const agentId of ["main", "work", "free-harness"]) {
      await upsertAcpSessionMeta({
        cfg,
        env,
        agentId,
        sessionKey: agentId === "free-harness" ? "agent:free-harness:acp:unrelated" : "global",
        mutate: () => ({
          backend: "acpx",
          agent: "fixture",
          mode: "persistent",
          runtimeSessionName: `old-${agentId}`,
          state: "idle",
          lastActivityAt: 10,
          identity: {
            state: "resolved",
            source: "ensure",
            lastUpdatedAt: 10,
            acpxRecordId: `record-${agentId}`,
            acpxSessionId: `upstream-${agentId}`,
          },
        }),
      });
    }
    const evidence = await readOnly.inspectAcpSessionClaims!();
    expect(evidence.incomplete).toEqual([]);
    expect(evidence.claims.map((claim) => claim.agentId).toSorted()).toEqual([
      "free-harness",
      "main",
      "work",
    ]);
    const claim = evidence.claims.find((item) => item.agentId === "work")!;
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("maintenance owner expired");
      }
    };
    const repair = createPluginDoctorStateMigrationContext({
      ...scope,
      repairAuthority: { assertCurrent, assertOwnedInTransaction: assertCurrent },
    });
    const update = { claim, runtimeSessionName: "owned-work", acpxRecordId: "owned-record-work" };
    repair.updateAcpSessionIdentity!(update);
    expect(readAcpSessionMeta({ cfg, env, agentId: "work", sessionKey: "global" })).toEqual({
      ...claim.meta,
      runtimeSessionName: "owned-work",
      identity: { ...claim.meta.identity, acpxRecordId: "owned-record-work" },
    });
    expect(
      readAcpSessionMeta({ cfg, env, agentId: "main", sessionKey: "global" })?.runtimeSessionName,
    ).toBe("old-main");
    expect(() => repair.updateAcpSessionIdentity!(update)).toThrow("metadata changed");
    const latest = (await repair.inspectAcpSessionClaims!()).claims.find(
      (item) => item.agentId === "work",
    )!;
    await updateSessionEntry({ agentId: "work", sessionKey: "global", env }, () => ({
      sessionId: "replacement-session",
      lifecycleRevision: "replacement",
    }));
    expect((await repair.inspectAcpSessionClaims!()).incomplete).toEqual([
      expect.stringContaining("binding is absent or stale"),
    ]);
    expect(() => repair.updateAcpSessionIdentity!({ ...update, claim: latest })).toThrow(
      "metadata changed",
    );
    current = false;
    expect(() => repair.updateAcpSessionIdentity!({ ...update, claim: latest })).toThrow(
      "maintenance owner expired",
    );
  });
});

it.each(["global", "shared-project"])(
  "migrates %s with real Doctor inventory beside an unrelated free ACP session",
  async (sessionKey) => {
    await withOpenClawTestState({ label: "acp-doctor-composition" }, async (state) => {
      const cfg = {
        agents: { ownership: "explicit" as const, entries: { main: {}, work: {} } },
        session: { scope: "global" as const },
      };
      await state.writeConfig(cfg);
      const peer = state.path("peer");
      await fs.mkdir(peer);
      const runtime = new AcpxRuntime({
        cwd: state.workspaceDir,
        sessionStore: createFileSessionStore({ stateDir: path.join(state.workspaceDir, "state") }),
        agentRegistry: createAgentRegistry({
          overrides: {
            fixture: [
              process.execPath,
              fileURLToPath(
                new URL("../../../extensions/acpx/test/fixtures/owner-agent.mjs", import.meta.url),
              ),
              peer,
            ].join(" "),
          },
        }),
        permissionMode: "deny-all",
        timeoutMs: 5000,
      });
      const handle = await runtime.ensureSession({
        sessionKey,
        agent: "fixture",
        mode: "persistent",
      });
      await runtime.close({ handle, reason: "offline-doctor" });
      const meta = {
        backend: "acpx",
        agent: "fixture",
        runtimeSessionName: handle.runtimeSessionName,
        mode: "persistent" as const,
        state: "idle" as const,
        lastActivityAt: 1,
        identity: {
          state: "resolved" as const,
          source: "ensure" as const,
          lastUpdatedAt: 1,
          acpxRecordId: handle.acpxRecordId,
          acpxSessionId: handle.backendSessionId,
        },
      };
      await upsertAcpSessionMeta({ cfg, agentId: "work", sessionKey, mutate: () => meta });
      const freeHandle = await runtime.ensureSession({
        sessionKey: "agent:free-harness:acp:unrelated",
        agent: "fixture",
        mode: "persistent",
      });
      await runtime.close({ handle: freeHandle, reason: "offline-doctor" });
      const freeTarget = {
        cfg,
        agentId: "free-harness",
        sessionKey: "agent:free-harness:acp:unrelated",
      };
      await upsertAcpSessionMeta({
        ...freeTarget,
        mutate: () => ({
          ...meta,
          runtimeSessionName: freeHandle.runtimeSessionName,
          identity: {
            ...meta.identity,
            acpxRecordId: freeHandle.acpxRecordId,
            acpxSessionId: freeHandle.backendSessionId,
          },
        }),
      });
      const scope = { pluginId: "acpx", config: cfg, env: state.env };
      const readOnly = createPluginDoctorStateMigrationContext(scope);
      const before = await readOnly.inspectAcpSessionClaims!();
      expect(before.incomplete).toEqual([]);
      expect(before.claims).toHaveLength(2);
      const rootDir = path.resolve("extensions/acpx");
      const modulePath = resolvePluginDoctorContractArtifactPath(rootDir)!;
      const load = getCachedPluginModuleLoader({
        modulePath,
        importerUrl: import.meta.url,
      });
      const { stateMigrations } = coercePluginDoctorContractModule(
        load(modulePath) as PluginDoctorContractModule,
      );
      const migration = stateMigrations.find((item) => item.id === "acpx-session-owner-resources")!;
      const context = createPluginDoctorStateMigrationContext({
        ...scope,
        repairAuthority: { assertCurrent() {}, assertOwnedInTransaction() {} },
      });
      const result = await migration.migrateLegacyState({
        config: cfg,
        env: state.env,
        stateDir: state.stateDir,
        oauthDir: state.path("oauth"),
        serviceWorkspaceDir: state.workspaceDir,
        context,
      });
      expect(result.warnings).toEqual([]);
      expect(result.changes.length).toBeGreaterThan(0);
      const migrated = readAcpSessionMeta({ cfg, agentId: "work", sessionKey });
      expect(migrated?.identity?.acpxRecordId).toMatch(/^openclaw-owner-v1-/);
      expect(
        (await readOnly.inspectAcpSessionClaims!()).claims.find(
          (claim) => claim.agentId === "free-harness",
        ),
      ).toEqual(before.claims.find((claim) => claim.agentId === "free-harness"));
      await expect(
        fs.access(
          path.join(state.workspaceDir, "state", "sessions", `${sessionKey}.json.migrated`),
        ),
      ).resolves.toBeUndefined();
    });
  },
);

it.each(["agent:retired:main", "agent:retired:acp:binding:configured", "global", "acp:bare"])(
  "rejects a retired configured or fixed-store claim %s",
  async (sessionKey) => {
    await withOpenClawTestState({ label: "acp-doctor-retired" }, async ({ env, stateDir }) => {
      const cfg = {
        agents: {
          ownership: "explicit" as const,
          entries: { main: {}, retired: {} },
          defaults: { sessionStore: { agentId: "retired" } },
        },
        session: { store: path.join(stateDir, "sessions.json") },
      };
      await upsertAcpSessionMeta({
        cfg,
        env,
        agentId: "retired",
        sessionKey,
        mutate: () => ({
          backend: "acpx",
          agent: "fixture",
          runtimeSessionName: "old",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 1,
        }),
      });
      const retired = { ...cfg, agents: { ...cfg.agents, entries: { main: {} } } };
      const evidence = await createPluginDoctorStateMigrationContext({
        pluginId: "acpx",
        config: retired,
        env,
      }).inspectAcpSessionClaims!();
      expect(evidence.claims).toEqual([]);
      expect(evidence.incomplete).toEqual([expect.stringContaining("retired")]);
    });
  },
);
