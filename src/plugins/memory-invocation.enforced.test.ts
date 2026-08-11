import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthorizedMemoryReadHost } from "../agents/memory-authorized-read-host.js";
import { referenceMemoryAuthorizationConformanceAdapter } from "../memory-host-sdk/host/authorization-conformance.js";
import {
  COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
  LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
  type AuthorizedMemoryPlan,
  type AuthorizedMemorySearchResult,
  type MemoryContentAccessContext,
} from "../memory-host-sdk/host/authorization.js";
import { ensureMemoryOperationalPrincipal } from "../state/memory-identity.js";
import { persistMemorySessionSubject } from "../state/memory-session-subject.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
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
  return host;
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
  searchAuthorized?: () => Promise<unknown>;
  authorize?: (context: MemoryContentAccessContext<"read">) => Promise<AuthorizedMemoryPlan>;
}) {
  const legacySearch = vi.fn();
  return {
    legacySearch,
    runtime: {
      authorize: async (context: MemoryContentAccessContext<"read">) =>
        await (params.authorize?.(context) ?? Promise.resolve(createPlan(context))),
      searchAuthorized: async () => await params.searchAuthorized?.(),
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
    const result = await createAuthorizedReadHost().search({ query: "private" });

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

    await expect(createAuthorizedReadHost().search({ query: "private" })).resolves.toBe(
      MEMORY_INVOCATION_UNAVAILABLE,
    );
    expect(legacySearch).not.toHaveBeenCalled();
  });
});
