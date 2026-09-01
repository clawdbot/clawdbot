import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AcpxRuntime as UpstreamRuntime,
  createAgentRegistry,
  createFileSessionStore,
  decodeAcpxRuntimeHandleState,
} from "acpx/runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { AcpxRuntime } from "./runtime.js";
import { acpxSessionOwnerMigration } from "./session-owner-migration.js";
import { resolveAcpxSessionResource } from "./session-resource.js";

type Claim = Awaited<
  ReturnType<NonNullable<PluginDoctorStateMigrationContext["inspectAcpSessionClaims"]>>
>["claims"][number];
const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => resetPluginStateStoreForTests());

async function fixture(mode: "persistent" | "oneshot" = "persistent", sessionKey = "global") {
  const directory = directories.make("acpx-owner-migration-");
  const stateDir = path.join(directory, "state");
  const peer = path.join(directory, "peer");
  await fs.mkdir(peer);
  const store = createFileSessionStore({ stateDir });
  const runtimeOptions = {
    cwd: directory,
    sessionStore: store,
    agentRegistry: createAgentRegistry({
      overrides: {
        fixture: [
          process.execPath,
          fileURLToPath(new URL("../test/fixtures/owner-agent.mjs", import.meta.url)),
          peer,
        ].join(" "),
      },
    }),
    permissionMode: "deny-all" as const,
    timeoutMs: 5_000,
  };
  const legacy = new UpstreamRuntime(runtimeOptions);
  const handle = await legacy.ensureSession({ sessionKey, agent: "fixture", mode });
  try {
    for await (const ignoredEventValue of legacy.runTurn({
      handle,
      text: "retained history",
      mode: "prompt",
      requestId: "before-migration",
    })) {
      void ignoredEventValue;
    }
  } finally {
    await legacy.close({ handle, reason: "offline-migration" });
  }
  const file = (id: string) => path.join(stateDir, "sessions", `${encodeURIComponent(id)}.json`);
  const sourcePath = file(handle.acpxRecordId!);
  const raw = JSON.parse(await fs.readFile(sourcePath, "utf8"));
  raw.future_field = { opaque: ["preserve", 42] };
  await fs.writeFile(sourcePath, JSON.stringify(raw));
  const claims: Claim[] = [
    {
      agentId: "work",
      sessionKey: "global",
      binding: { sessionId: "openclaw-session", lifecycleRevision: "revision" },
      meta: {
        backend: "acpx",
        agent: "fixture",
        runtimeSessionName: handle.runtimeSessionName,
        mode,
        state: "idle",
        lastActivityAt: 10,
        identity: {
          state: "resolved",
          source: "ensure",
          lastUpdatedAt: 10,
          acpxRecordId: handle.acpxRecordId,
          acpxSessionId: handle.backendSessionId,
        },
      },
    },
  ];
  let interrupt = false;
  let interruptVerification = false;
  let updated = false;
  const context: PluginDoctorStateMigrationContext = {
    openPluginStateKeyedStore: (options) =>
      createPluginStateKeyedStoreForTests("acpx", {
        ...options,
        env: { ...process.env, OPENCLAW_STATE_DIR: directory },
      }),
    inspectAcpSessionClaims: async () => ({
      claims: structuredClone(claims),
      incomplete: interruptVerification && updated ? ["interrupted after canonical update"] : [],
    }),
    updateAcpSessionIdentity(input) {
      if (interrupt) {
        throw new Error("interrupted after publication");
      }
      expect(claims[0]).toEqual(input.claim);
      claims[0]!.meta.runtimeSessionName = input.runtimeSessionName;
      claims[0]!.meta.identity!.acpxRecordId = input.acpxRecordId;
      updated = true;
    },
  };
  const input = {
    config: {},
    env: { ...process.env, OPENCLAW_STATE_DIR: directory },
    stateDir: directory,
    oauthDir: path.join(directory, "oauth"),
    serviceWorkspaceDir: directory,
    context,
  };
  return {
    claims,
    file,
    handle,
    input,
    raw,
    sourcePath,
    runtimeOptions,
    setVerificationInterrupted: (value: boolean) => {
      interruptVerification = value;
    },
    setInterrupted: (value: boolean) => {
      interrupt = value;
    },
  };
}

it.each(["missing", "empty"])(
  "does not inspect session claims when the legacy directory is %s",
  async (directoryState) => {
    const directory = directories.make("acpx-empty-owner-migration-");
    if (directoryState === "empty") {
      await fs.mkdir(path.join(directory, "state", "sessions"), { recursive: true });
    }
    const context: PluginDoctorStateMigrationContext = {
      openPluginStateKeyedStore() {
        throw new Error("No record requires a state store");
      },
      async inspectAcpSessionClaims() {
        throw new Error("No record requires canonical ownership evidence");
      },
    };
    await expect(
      acpxSessionOwnerMigration.detectLegacyState({
        config: {},
        env: { ...process.env, OPENCLAW_STATE_DIR: directory },
        stateDir: directory,
        oauthDir: path.join(directory, "oauth"),
        serviceWorkspaceDir: directory,
        context,
      }),
    ).resolves.toBeNull();
  },
);

it.each(["none", "publication", "canonical"])(
  "preserves raw history and resumes idempotently after interruption=%s",
  async (interrupted) => {
    const f = await fixture();
    const resource = resolveAcpxSessionResource(f.claims[0]!);
    if (interrupted === "canonical") {
      f.setVerificationInterrupted(true);
      expect((await acpxSessionOwnerMigration.migrateLegacyState(f.input)).warnings).toEqual([
        expect.stringContaining("canonical metadata verification failed"),
      ]);
      expect(JSON.parse(await fs.readFile(f.sourcePath, "utf8"))).toEqual(f.raw);
      f.setVerificationInterrupted(false);
    }
    if (interrupted === "publication") {
      f.setInterrupted(true);
      expect((await acpxSessionOwnerMigration.migrateLegacyState(f.input)).warnings).toEqual([
        expect.stringContaining("interrupted after publication"),
      ]);
      expect(JSON.parse(await fs.readFile(f.sourcePath, "utf8"))).toEqual(f.raw);
      f.setInterrupted(false);
    }
    const result = await acpxSessionOwnerMigration.migrateLegacyState(f.input);
    expect(result.warnings).toEqual([]);
    expect(JSON.parse(await fs.readFile(f.file(resource), "utf8"))).toEqual({
      ...f.raw,
      name: resource,
      acpx_record_id: resource,
    });
    expect(JSON.parse(await fs.readFile(`${f.sourcePath}.migrated`, "utf8"))).toEqual(f.raw);
    expect(decodeAcpxRuntimeHandleState(f.claims[0]!.meta.runtimeSessionName)).toMatchObject({
      name: resource,
      acpxRecordId: resource,
    });
    expect(await acpxSessionOwnerMigration.migrateLegacyState(f.input)).toEqual({
      changes: [],
      warnings: [],
    });
    const runtime = new AcpxRuntime(f.runtimeOptions);
    const handle = await runtime.ensureSession({
      sessionKey: "global",
      agentId: "work",
      agent: "fixture",
      mode: "persistent",
      persistedHandle: {
        ...f.handle,
        agentId: "work",
        runtimeSessionName: f.claims[0]!.meta.runtimeSessionName,
        acpxRecordId: resource,
      },
    });
    try {
      const chunks: string[] = [];
      for await (const event of runtime.runTurn({
        handle,
        text: "after-migration",
        requestId: "after",
        mode: "prompt",
      })) {
        if (event.type === "text_delta") {
          chunks.push(event.text);
        }
      }
      expect(JSON.parse(chunks.join(""))).toMatchObject({
        history: ["retained history", "after-migration"],
      });
    } finally {
      await runtime.close({ handle, reason: "test-complete" });
    }
  },
);

it.each(["ambiguous", "missing", "event-log", "conflict", "live"])(
  "leaves %s records intact",
  async (scenario) => {
    const f = await fixture();
    const resource = resolveAcpxSessionResource(f.claims[0]!);
    if (scenario === "ambiguous") {
      f.claims.push({ ...structuredClone(f.claims[0]!), agentId: "main" });
    }
    if (scenario === "missing") {
      f.claims.length = 0;
    }
    if (scenario === "event-log") {
      f.raw.event_log = {};
    }
    if (scenario === "live") {
      f.raw.pid = process.pid;
    }
    if (scenario === "conflict") {
      await fs.writeFile(f.file(resource), '{"conflict":true}');
    }
    await fs.writeFile(f.sourcePath, JSON.stringify(f.raw));
    const before = await fs.readFile(f.sourcePath, "utf8");
    const result = await acpxSessionOwnerMigration.migrateLegacyState(f.input);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.changes).toEqual([]);
    expect(await fs.readFile(f.sourcePath, "utf8")).toBe(before);
    if (scenario === "conflict") {
      expect(await fs.readFile(f.file(resource), "utf8")).toBe('{"conflict":true}');
    }
  },
);

it.each(["runtime", "doctor"])(
  "%s rejects an unclaimed legacy record whose raw key looks owner-qualified",
  async (boundary) => {
    const target = { agentId: "work", sessionKey: "global" };
    const resource = resolveAcpxSessionResource(target);
    const f = await fixture("persistent", resource);
    f.claims.length = 0;
    const before = await fs.readFile(f.sourcePath, "utf8");
    if (boundary === "doctor") {
      expect(await acpxSessionOwnerMigration.detectLegacyState(f.input)).not.toBeNull();
      expect((await acpxSessionOwnerMigration.migrateLegacyState(f.input)).warnings).toEqual([
        expect.stringContaining("exactly one current canonical owner claim is required"),
      ]);
    } else {
      const runtime = new AcpxRuntime({
        ...f.runtimeOptions,
        openclawLegacyBareSessionKeys: new Set([resource]),
      });
      let adopted: Awaited<ReturnType<AcpxRuntime["ensureSession"]>> | undefined;
      try {
        await expect(
          runtime
            .ensureSession({ ...target, agent: "fixture", mode: "persistent" })
            .then((handle) => {
              adopted = handle;
              return handle;
            }),
        ).rejects.toMatchObject({ detailCode: "SESSION_OWNER_MIGRATION_REQUIRED" });
        await expect(runtime.prepareFreshSession(target)).rejects.toMatchObject({
          detailCode: "SESSION_OWNER_MIGRATION_REQUIRED",
        });
      } finally {
        if (adopted) {
          await runtime.close({ handle: adopted, reason: "test-cleanup" });
        }
      }
    }
    expect(await fs.readFile(f.sourcePath, "utf8")).toBe(before);
  },
);

it("keeps oneshot physical IDs and bytes while repairing the canonical locator", async () => {
  const f = await fixture("oneshot");
  const before = await fs.readFile(f.sourcePath, "utf8");
  expect(f.handle.acpxRecordId).toMatch(/^global:oneshot:/);
  expect((await acpxSessionOwnerMigration.migrateLegacyState(f.input)).warnings).toEqual([]);
  expect(await fs.readFile(f.sourcePath, "utf8")).toBe(before);
  expect(f.claims[0]!.meta.identity?.acpxRecordId).toBe(f.handle.acpxRecordId);
  expect(decodeAcpxRuntimeHandleState(f.claims[0]!.meta.runtimeSessionName)?.name).toBe(
    resolveAcpxSessionResource(f.claims[0]!),
  );
  expect(await acpxSessionOwnerMigration.detectLegacyState(f.input)).toBeNull();
});

it("requires repair when a bare backend locator belongs to an agent-qualified canonical key", async () => {
  const f = await fixture("persistent", "shared-project");
  f.claims[0]!.sessionKey = "agent:work:shared-project";
  const runtime = new AcpxRuntime(f.runtimeOptions);
  const target = {
    sessionKey: f.claims[0]!.sessionKey,
    agentId: "work",
    agent: "fixture",
    mode: "persistent" as const,
    persistedHandle: f.handle,
  };
  await expect(runtime.ensureSession(target)).rejects.toMatchObject({
    detailCode: "SESSION_OWNER_MIGRATION_REQUIRED",
  });
  await expect(runtime.prepareFreshSession(target)).rejects.toMatchObject({
    detailCode: "SESSION_OWNER_MIGRATION_REQUIRED",
  });
  expect(JSON.parse(await fs.readFile(f.sourcePath, "utf8"))).toEqual(f.raw);
  expect((await acpxSessionOwnerMigration.migrateLegacyState(f.input)).warnings).toEqual([]);
  const resource = resolveAcpxSessionResource(f.claims[0]!);
  expect(resource).toBe(target.sessionKey);
  expect(JSON.parse(await fs.readFile(f.file(resource), "utf8"))).toEqual({
    ...f.raw,
    acpx_record_id: resource,
    name: resource,
  });
});
