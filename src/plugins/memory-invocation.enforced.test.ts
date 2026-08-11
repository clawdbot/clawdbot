import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthorizedMemoryReadHost } from "../agents/memory-authorized-read-host.js";
import { referenceMemoryAuthorizationConformanceAdapter } from "../plugin-sdk/memory-authorization-conformance.js";
import {
  COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
  LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
  type AuthorizedMemoryPlan,
  type AuthorizedMemorySearchResult,
  type MemoryContentAccessContext,
} from "../plugin-sdk/memory-authorization.js";
import { ensureMemoryOperationalPrincipal } from "../state/memory-identity.js";
import { persistMemorySessionSubject } from "../state/memory-session-subject.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { ensureOpenClawAgentScopedMemorySchema } from "../state/openclaw-agent-scoped-memory-schema.js";
import { resetMemoryIsolationCutoverForTest } from "./memory-cutover.js";
import { MEMORY_INVOCATION_UNAVAILABLE } from "./memory-invocation.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

const roots: string[] = [];

function createPlan(
  context: MemoryContentAccessContext<"read">,
): AuthorizedMemoryPlan & Readonly<{ operation: "read" }> {
  return {
    version: 1,
    planId: "plan-1",
    contextFingerprint: context.contextFingerprint,
    runId: context.runId,
    agentId: context.agentId,
    sessionId: context.sessionId,
    sessionIdentityRevision: context.sessionIdentityRevision,
    subjectRevision: context.subjectRevision,
    memoryPolicyRevision: "policy-1",
    deliveryRevision: context.delivery.deliveryRevision,
    operation: "read",
    mounts: [],
    bootstrapResourceHandles: [],
    allowedEgressAudiences: context.delivery.audiences,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function createAuthorizedReadHost() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-invocation-"));
  roots.push(root);
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const agentId = "main";
  const sessionKey = "agent:main:internal:memory-invocation";
  const sessionId = "memory-invocation-session";
  const options = { agentId, env };
  const database = openOpenClawAgentDatabase(options);
  ensureOpenClawAgentScopedMemorySchema(database.db);
  database.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, '{}', 1)",
    )
    .run(sessionKey, sessionId);
  database.db
    .prepare(
      `INSERT INTO session_windows
       (session_id, session_key, created_at, updated_at, chat_type, channel, account_id)
       VALUES (?, ?, 1, 1, 'direct', 'internal', 'default')`,
    )
    .run(sessionId, sessionKey);
  const principal = ensureMemoryOperationalPrincipal({
    kind: "service",
    stableRef: "memory-invocation-test-service",
    options: { env },
  });
  persistMemorySessionSubject({
    sessionKey,
    sessionId,
    subject: { kind: "service", principalId: principal.principalId },
    options,
  });
  database.db
    .prepare(
      `INSERT INTO memory_migrations
        (migration_id, source_kind, source_hash, phase, classification_json, plan_hash,
         verified_at, cutover_at, updated_at)
       VALUES ('memory-invocation-cutover', 'test', 'test-source', 'cutover', '{}', 'test-plan', 1, 1, 1)`,
    )
    .run();
  resetMemoryIsolationCutoverForTest();
  const host = createAuthorizedMemoryReadHost({
    agentId,
    sessionKey,
    sessionId,
    runId: "run-1",
  });
  if (!host) {
    throw new Error("failed to create authorized memory read host");
  }
  return { database, host };
}

function registerSelectedCapability(capability: unknown) {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push({ id: "selected-memory", memorySlotSelected: true } as never);
  registry.memoryCapabilities.push({
    pluginId: "selected-memory",
    capability,
  } as never);
  setActivePluginRegistry(registry);
}

function createRuntime(params: {
  searchAuthorized?: (context: MemoryContentAccessContext<"read">) => Promise<unknown>;
  authorize?: (context: MemoryContentAccessContext<"read">) => Promise<AuthorizedMemoryPlan>;
}) {
  const legacySearch = vi.fn();
  return {
    legacySearch,
    runtime: {
      authorize: async (context: MemoryContentAccessContext<"read">) =>
        await (params.authorize?.(context) ?? Promise.resolve(createPlan(context))),
      searchAuthorized: async ({ context }: { context: MemoryContentAccessContext<"read"> }) =>
        await params.searchAuthorized?.(context),
      readAuthorized: async () => {
        throw new Error("exact read must not execute in this test");
      },
      getMemorySearchManager: async () => ({
        manager: { search: legacySearch },
      }),
      resolveMemoryBackendConfig: () => ({ backend: "builtin" as const }),
    },
  };
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
  resetMemoryIsolationCutoverForTest();
  closeOpenClawAgentDatabasesForTest();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("enforced selected-memory invocation failures", () => {
  it.each([
    {
      name: "the selected plugin crashes during search",
      searchAuthorized: async () => {
        throw new Error("private legacy content");
      },
    },
    {
      name: "the selected plugin omits exposure and egress receipts",
      searchAuthorized: async () => ({ value: [] }) as unknown,
    },
    {
      name: "the selected plugin returns a stale egress receipt",
      searchAuthorized: async () => ({
        value: [] as readonly AuthorizedMemorySearchResult[],
        exposureReceipt: {
          version: 1,
          receiptId: "exposure-1",
          contextFingerprint: "unused",
          planId: "unused",
          runId: "unused",
          runExposureRevision: "run-1",
          sourcePolicySetId: "policy-set-1",
          exposedRevisionHandles: [],
          recordedAt: new Date().toISOString(),
        },
        egressReceipt: {
          version: 1,
          receiptId: "egress-1",
          contextFingerprint: "unused",
          planId: "unused",
          runId: "unused",
          runExposureRevision: "run-1",
          sourcePolicySetId: "policy-set-1",
          allowedAudiences: [],
          deliveryRevision: "unused",
          egressRegistryRevision: "unused",
          expiresAt: new Date(0).toISOString(),
        },
      }),
    },
  ])("returns only generic unavailability when $name", async ({ searchAuthorized }) => {
    const { runtime, legacySearch } = createRuntime({ searchAuthorized });
    registerSelectedCapability({
      authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
      authorizationConformance: referenceMemoryAuthorizationConformanceAdapter,
      runtime,
    });
    const result = await createAuthorizedReadHost().host.search({ query: "private" });

    expect(result).toBe(MEMORY_INVOCATION_UNAVAILABLE);
    expect(JSON.stringify(result)).not.toContain("private legacy content");
    expect(legacySearch).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "the selected plugin is disabled",
      capability: {},
    },
    {
      name: "the selected plugin is nonconforming",
      capability: {
        authorization: LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
        authorizationConformance: referenceMemoryAuthorizationConformanceAdapter,
        runtime: createRuntime({}).runtime,
      },
    },
  ])("does not acquire legacy search when $name", async ({ capability }) => {
    const legacySearch = vi.fn();
    if ("runtime" in capability && capability.runtime) {
      capability.runtime.getMemorySearchManager = async () => ({
        manager: { search: legacySearch },
      });
    }
    registerSelectedCapability(capability);

    await expect(createAuthorizedReadHost().host.search({ query: "private" })).resolves.toBe(
      MEMORY_INVOCATION_UNAVAILABLE,
    );
    expect(legacySearch).not.toHaveBeenCalled();
  });

  it("commits the content-free exposure ledger before returning a selected-plugin result", async () => {
    const { runtime } = createRuntime({
      searchAuthorized: async (context) => ({
        version: 1,
        value: [
          {
            path: "private/note.md",
            startLine: 1,
            endLine: 1,
            score: 1,
            snippet: "allowed text",
            source: "memory",
            resourceHandle: {
              version: 1,
              handleId: "handle-1",
              planId: "plan-1",
              contextFingerprint: context.contextFingerprint,
              resourceRevision: "revision-1",
              policyRevision: "policy-1",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          },
        ],
        exposureReceipt: {
          version: 1,
          receiptId: "exposure-1",
          contextFingerprint: context.contextFingerprint,
          planId: "plan-1",
          runId: context.runId,
          runExposureRevision: "run-exposure-1",
          sourcePolicySetId: "source-policy-1",
          exposedRevisionHandles: ["revision-1"],
          recordedAt: new Date().toISOString(),
        },
        egressReceipt: {
          version: 1,
          receiptId: "egress-1",
          contextFingerprint: context.contextFingerprint,
          planId: "plan-1",
          runId: context.runId,
          runExposureRevision: "run-exposure-1",
          sourcePolicySetId: "source-policy-1",
          allowedAudiences: context.delivery.audiences,
          deliveryRevision: context.delivery.deliveryRevision,
          egressRegistryRevision: context.delivery.egressRegistryRevision,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    });
    registerSelectedCapability({
      authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
      authorizationConformance: referenceMemoryAuthorizationConformanceAdapter,
      runtime,
    });
    const { database, host } = createAuthorizedReadHost();

    await expect(host.search({ query: "private" })).resolves.toEqual({
      results: [
        {
          handleId: "handle-1",
          path: "private/note.md",
          startLine: 1,
          endLine: 1,
          score: 1,
          snippet: "allowed text",
          source: "memory",
        },
      ],
    });
    expect(
      database.db
        .prepare(
          `SELECT session_id, run_id, revision_number, exposure_receipt_ids_json
           FROM memory_preoutput_exposure_ledger`,
        )
        .all(),
    ).toEqual([
      {
        session_id: "memory-invocation-session",
        run_id: "run-1",
        revision_number: 1,
        exposure_receipt_ids_json: '["exposure-1"]',
      },
    ]);
  });
});
