import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMemoryAuthorizationConformanceSuite } from "openclaw/plugin-sdk/memory-authorization-conformance";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  builtinScopedMemoryConformanceAdapter,
  evaluateBuiltinScopedMemoryPolicy,
} from "./scoped-memory-policy.js";
import {
  createBuiltinScopedMemoryStore,
  reviseBuiltinScopedMemoryPolicy,
} from "./scoped-memory-store.js";

describe("builtin scoped memory policy conformance", () => {
  let stateDir = "";

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-scoped-memory-policy-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("passes the full current host authorization conformance suite", async () => {
    await expect(
      runMemoryAuthorizationConformanceSuite(builtinScopedMemoryConformanceAdapter),
    ).resolves.toEqual({
      ok: true,
      failures: [],
    });
  });

  it("evaluates persisted placement, deny precedence, expiry, and operation implication", () => {
    const store = createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "user",
      audienceKind: "user",
      audienceId: "alice",
      authorityKind: "user",
      authorityOwnerId: "alice",
      defaultCapabilities: ["retrieve", "read"],
      actor: { kind: "human", id: "alice" },
      reason: "private placement",
      nowMs: 1_000,
    });
    const evaluate = (operation: "read" | "derive", nowMs = 2_000) =>
      evaluateBuiltinScopedMemoryPolicy({
        agentId: "main",
        storeId: store.storeId,
        principalIds: ["alice"],
        deliveryAudiences: [{ kind: "user", id: "alice" }],
        operation,
        nowMs,
      });

    expect(evaluate("read")).toMatchObject({ allowed: true, reasonCode: "allowed" });
    expect(
      evaluateBuiltinScopedMemoryPolicy({
        agentId: "main",
        storeId: store.storeId,
        principalIds: ["bob"],
        deliveryAudiences: [{ kind: "user", id: "alice" }],
        operation: "read",
        nowMs: 2_000,
      }),
    ).toMatchObject({ allowed: false, reasonCode: "outside-view" });
    expect(evaluate("derive")).toMatchObject({ allowed: false, reasonCode: "default-deny" });
    reviseBuiltinScopedMemoryPolicy({
      agentId: "main",
      policyId: store.policyId,
      entries: [
        {
          effect: "deny",
          principalId: "alice",
          operation: "read",
          grantorPrincipalId: "alice",
          reason: "deny takes precedence",
        },
      ],
      actor: { kind: "human", id: "alice" },
      reason: "temporary deny",
      nowMs: 3_000,
    });
    expect(evaluate("read", 3_000)).toMatchObject({
      allowed: false,
      reasonCode: "explicit-deny",
    });
    reviseBuiltinScopedMemoryPolicy({
      agentId: "main",
      policyId: store.policyId,
      entries: [
        {
          effect: "deny",
          principalId: "alice",
          operation: "read",
          grantorPrincipalId: "alice",
          reason: "expired deny",
          expiresAt: 3_500,
        },
        {
          effect: "allow",
          principalId: "alice",
          operation: "derive",
          grantorPrincipalId: "alice",
          reason: "derived memory is explicit",
        },
      ],
      actor: { kind: "human", id: "alice" },
      reason: "allow derivation after expiry",
      nowMs: 3_100,
    });
    expect(evaluate("read", 3_500)).toMatchObject({ allowed: true, reasonCode: "allowed" });
    expect(evaluate("derive", 3_500)).toMatchObject({ allowed: true, reasonCode: "allowed" });
    expect(
      evaluateBuiltinScopedMemoryPolicy({
        agentId: "main",
        storeId: store.storeId,
        principalIds: ["alice"],
        deliveryAudiences: [{ kind: "conversation", id: "conversation-1" }],
        operation: "read",
        nowMs: 3_500,
      }),
    ).toMatchObject({ allowed: false, reasonCode: "outside-view" });
  });
});
