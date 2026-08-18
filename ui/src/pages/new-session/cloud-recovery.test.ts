import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cloudSessionRecoveryExactStorageKey,
  cloudSessionRecoveryLegacyStorageKey,
  cloudSessionRecoveryScopeStoragePrefix,
} from "../../lib/sessions/cloud-recovery-storage-key.ts";
import {
  clearCloudSessionRecovery,
  listCloudSessionRecoveries,
  migrateCloudSessionRecoveryScope,
  parseCloudSessionCreateParams,
  readCloudSessionRecovery,
  writeCloudSessionRecovery,
  writeCloudSessionRecoveryIfAvailable,
} from "../../lib/sessions/cloud-recovery.ts";

const recovery = {
  sessionKey: "agent:cloud:one",
  messageId: "message-1",
  message: "run remotely",
  profileId: "aws",
  agentId: "cloud",
  gatewayUrl: "ws://gateway.example",
  recoveryScope: "principal-a",
  phase: "dispatching" as const,
};

const exactKey = (sessionKey: string) =>
  cloudSessionRecoveryExactStorageKey(recovery.gatewayUrl, recovery.recoveryScope, sessionKey);
const legacyKey = cloudSessionRecoveryLegacyStorageKey(recovery.gatewayUrl, recovery.recoveryScope);

describe("cloud session recovery", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("frames every v2 namespace component without URI encoding", () => {
    const gatewayUrl = "ws://gateway.example";
    const recoveryScope = "principal-a";
    const sessionKey = "admin";
    const scopePrefix = cloudSessionRecoveryScopeStoragePrefix(gatewayUrl, recoveryScope);
    expect(scopePrefix).toBe(
      `openclaw.new-session.cloud-recovery.v2:${gatewayUrl.length}:${gatewayUrl}:${recoveryScope.length}:${recoveryScope}:`,
    );
    expect(cloudSessionRecoveryExactStorageKey(gatewayUrl, recoveryScope, sessionKey)).toBe(
      `${scopePrefix}${sessionKey.length}:${sessionKey}`,
    );
    expect(cloudSessionRecoveryExactStorageKey(gatewayUrl, recoveryScope, sessionKey)).not.toBe(
      cloudSessionRecoveryLegacyStorageKey(gatewayUrl, `${recoveryScope}:${sessionKey}`),
    );

    const colonGateway = `${gatewayUrl}:principal-a`;
    expect(cloudSessionRecoveryLegacyStorageKey(colonGateway, "admin")).toBe(
      cloudSessionRecoveryLegacyStorageKey(gatewayUrl, "principal-a:admin"),
    );
    expect(cloudSessionRecoveryScopeStoragePrefix(colonGateway, "admin")).not.toBe(
      cloudSessionRecoveryScopeStoragePrefix(gatewayUrl, "principal-a:admin"),
    );

    expect(cloudSessionRecoveryExactStorageKey(gatewayUrl, recoveryScope, "\ud800")).not.toBe(
      cloudSessionRecoveryExactStorageKey(gatewayUrl, recoveryScope, "\ud801"),
    );
  });

  it("keeps two recoveries in one scope independently readable and clearable", () => {
    const second = {
      ...recovery,
      sessionKey: "agent:cloud:two",
      messageId: "message-2",
      message: "run another task",
    };
    expect(writeCloudSessionRecovery(recovery)).toBe(true);
    expect(writeCloudSessionRecovery(second)).toBe(true);
    expect(listCloudSessionRecoveries(recovery.gatewayUrl, recovery.recoveryScope)).toEqual([
      recovery,
      second,
    ]);
    expect(
      readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope, recovery.sessionKey),
    ).toEqual(recovery);

    clearCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope, recovery.sessionKey);
    expect(
      readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope, recovery.sessionKey),
    ).toBeNull();
    expect(
      readCloudSessionRecovery(second.gatewayUrl, second.recoveryScope, second.sessionKey),
    ).toEqual(second);

    clearCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope);
    expect(listCloudSessionRecoveries(recovery.gatewayUrl, recovery.recoveryScope)).toEqual([]);
  });

  it("migrates a valid legacy record during list without replacing a valid v2 record", () => {
    sessionStorage.setItem(legacyKey, JSON.stringify(recovery));
    expect(listCloudSessionRecoveries(recovery.gatewayUrl, recovery.recoveryScope)).toEqual([
      recovery,
    ]);
    expect(sessionStorage.getItem(legacyKey)).toBeNull();
    expect(sessionStorage.getItem(exactKey(recovery.sessionKey))).not.toBeNull();

    const current = { ...recovery, message: "new per-session task" };
    sessionStorage.setItem(exactKey(recovery.sessionKey), JSON.stringify(current));
    sessionStorage.setItem(
      legacyKey,
      JSON.stringify({ ...recovery, message: "stale legacy task" }),
    );
    expect(listCloudSessionRecoveries(recovery.gatewayUrl, recovery.recoveryScope)).toEqual([
      current,
    ]);
    expect(sessionStorage.getItem(legacyKey)).toBeNull();
  });

  it("migrates a valid legacy record during exact read", () => {
    sessionStorage.setItem(legacyKey, JSON.stringify(recovery));

    expect(
      readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope, recovery.sessionKey),
    ).toEqual(recovery);
    expect(sessionStorage.getItem(legacyKey)).toBeNull();
    expect(sessionStorage.getItem(exactKey(recovery.sessionKey))).toBe(JSON.stringify(recovery));
  });

  it("claims only exact legacy-scope v1 and v2 rows under a new scope", () => {
    const legacyScope = recovery.recoveryScope;
    const newScope = "gateway-principal";
    const second = {
      ...recovery,
      sessionKey: "agent:cloud:two",
      messageId: "message-2",
    };
    const unrelatedScope = { ...recovery, recoveryScope: "principal-other" };
    const unrelatedGateway = { ...recovery, gatewayUrl: "ws://other.example" };
    sessionStorage.setItem(legacyKey, JSON.stringify(recovery));
    expect(writeCloudSessionRecovery(second)).toBe(true);
    expect(writeCloudSessionRecovery(unrelatedScope)).toBe(true);
    expect(writeCloudSessionRecovery(unrelatedGateway)).toBe(true);

    migrateCloudSessionRecoveryScope(recovery.gatewayUrl, legacyScope, newScope);

    expect(listCloudSessionRecoveries(recovery.gatewayUrl, newScope)).toEqual([
      { ...recovery, recoveryScope: newScope },
      { ...second, recoveryScope: newScope },
    ]);
    expect(listCloudSessionRecoveries(recovery.gatewayUrl, legacyScope)).toEqual([]);
    expect(
      listCloudSessionRecoveries(unrelatedScope.gatewayUrl, unrelatedScope.recoveryScope),
    ).toEqual([unrelatedScope]);
    expect(listCloudSessionRecoveries(unrelatedGateway.gatewayUrl, legacyScope)).toEqual([
      unrelatedGateway,
    ]);
  });

  it("preserves source bytes on destination collision, write failure, and clear failure", () => {
    const newScope = "gateway-principal";
    const sourceRaw = ` ${JSON.stringify(recovery)}\n`;
    const sourceKey = exactKey(recovery.sessionKey);
    const destination = {
      ...recovery,
      messageId: "message-destination",
      message: "keep the destination task",
      recoveryScope: newScope,
    };
    const destinationKey = cloudSessionRecoveryExactStorageKey(
      recovery.gatewayUrl,
      newScope,
      recovery.sessionKey,
    );
    sessionStorage.setItem(sourceKey, sourceRaw);
    expect(writeCloudSessionRecovery(destination)).toBe(true);

    migrateCloudSessionRecoveryScope(recovery.gatewayUrl, recovery.recoveryScope, newScope);
    expect(sessionStorage.getItem(sourceKey)).toBe(sourceRaw);
    expect(readCloudSessionRecovery(recovery.gatewayUrl, newScope, recovery.sessionKey)).toEqual(
      destination,
    );

    sessionStorage.removeItem(destinationKey);
    const storage = sessionStorage;
    vi.stubGlobal("sessionStorage", {
      get length() {
        return storage.length;
      },
      getItem: storage.getItem.bind(storage),
      key: storage.key.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      setItem: vi.fn((key: string, value: string) => {
        if (key === destinationKey) {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        }
        storage.setItem(key, value);
      }),
    });
    migrateCloudSessionRecoveryScope(recovery.gatewayUrl, recovery.recoveryScope, newScope);
    expect(storage.getItem(sourceKey)).toBe(sourceRaw);
    expect(storage.getItem(destinationKey)).toBeNull();

    vi.stubGlobal("sessionStorage", {
      get length() {
        return storage.length;
      },
      getItem: storage.getItem.bind(storage),
      key: storage.key.bind(storage),
      removeItem: vi.fn((key: string) => {
        if (key !== sourceKey) {
          storage.removeItem(key);
        }
      }),
      setItem: storage.setItem.bind(storage),
    });
    migrateCloudSessionRecoveryScope(recovery.gatewayUrl, recovery.recoveryScope, newScope);
    expect(storage.getItem(sourceKey)).toBe(sourceRaw);
    expect(readCloudSessionRecovery(recovery.gatewayUrl, newScope, recovery.sessionKey)).toEqual({
      ...recovery,
      recoveryScope: newScope,
    });
  });

  it("removes only hostile v2 rows while preserving valid siblings", () => {
    const surrogateRecovery = {
      ...recovery,
      sessionKey: "\ud800",
      messageId: "message-surrogate",
    };
    expect(writeCloudSessionRecovery(recovery)).toBe(true);
    expect(writeCloudSessionRecovery(surrogateRecovery)).toBe(true);
    sessionStorage.setItem(legacyKey, JSON.stringify({ ...recovery, messageId: "" }));
    sessionStorage.setItem(
      exactKey("agent:cloud:incognito"),
      JSON.stringify({ ...recovery, createParams: { incognito: true } }),
    );
    sessionStorage.setItem(
      exactKey("agent:cloud:wrong-key"),
      JSON.stringify({ ...recovery, messageId: "message-valid" }),
    );
    const invalidPayload = {
      ...recovery,
      sessionKey: "agent:cloud:invalid-payload",
      messageId: "",
    };
    sessionStorage.setItem(exactKey(invalidPayload.sessionKey), JSON.stringify(invalidPayload));
    const malformedKey = exactKey("\ud801");
    sessionStorage.setItem(malformedKey, "{not-json");

    const listed = listCloudSessionRecoveries(recovery.gatewayUrl, recovery.recoveryScope);
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining([recovery, surrogateRecovery]));
    expect(sessionStorage.getItem(exactKey(recovery.sessionKey))).not.toBeNull();
    expect(sessionStorage.getItem(exactKey(surrogateRecovery.sessionKey))).not.toBeNull();
    expect(sessionStorage.getItem(exactKey("agent:cloud:incognito"))).toBeNull();
    expect(sessionStorage.getItem(exactKey("agent:cloud:wrong-key"))).toBeNull();
    expect(sessionStorage.getItem(exactKey(invalidPayload.sessionKey))).toBeNull();
    expect(sessionStorage.getItem(malformedKey)).toBeNull();
    expect(sessionStorage.getItem(legacyKey)).toBeNull();
  });

  it("isolates parent sessions from nested legacy scopes", () => {
    const nested = {
      ...recovery,
      sessionKey: "agent:cloud:nested",
      messageId: "message-nested",
      recoveryScope: "principal-a:admin",
    };
    expect(writeCloudSessionRecovery(recovery)).toBe(true);
    sessionStorage.setItem(
      cloudSessionRecoveryLegacyStorageKey(nested.gatewayUrl, nested.recoveryScope),
      JSON.stringify(nested),
    );
    const invalidNested = {
      ...nested,
      sessionKey: "agent:cloud:invalid-nested",
      recoveryScope: "principal-a:ops",
      messageId: "",
    };
    sessionStorage.setItem(
      cloudSessionRecoveryLegacyStorageKey(invalidNested.gatewayUrl, invalidNested.recoveryScope),
      JSON.stringify(invalidNested),
    );

    expect(listCloudSessionRecoveries(recovery.gatewayUrl, recovery.recoveryScope)).toEqual([
      recovery,
    ]);
    const parentAdmin = {
      ...recovery,
      sessionKey: "admin",
      messageId: "message-collision",
    };
    expect(writeCloudSessionRecovery(parentAdmin)).toBe(true);
    expect(
      readCloudSessionRecovery(
        parentAdmin.gatewayUrl,
        parentAdmin.recoveryScope,
        parentAdmin.sessionKey,
      ),
    ).toEqual(parentAdmin);
    clearCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope);
    expect(
      readCloudSessionRecovery(nested.gatewayUrl, nested.recoveryScope, nested.sessionKey),
    ).toEqual(nested);
    expect(
      sessionStorage.getItem(
        cloudSessionRecoveryLegacyStorageKey(invalidNested.gatewayUrl, invalidNested.recoveryScope),
      ),
    ).not.toBeNull();
    expect(
      listCloudSessionRecoveries(invalidNested.gatewayUrl, invalidNested.recoveryScope),
    ).toEqual([]);
    expect(sessionStorage.length).toBe(1);
  });

  it("isolates gateway and scope tuples that collide under v1", () => {
    const first = {
      ...recovery,
      gatewayUrl: `${recovery.gatewayUrl}:principal-a`,
      recoveryScope: "admin",
      sessionKey: "agent:cloud:first",
    };
    const second = {
      ...recovery,
      recoveryScope: "principal-a:admin",
      sessionKey: "agent:cloud:second",
      messageId: "message-2",
    };
    expect(cloudSessionRecoveryLegacyStorageKey(first.gatewayUrl, first.recoveryScope)).toBe(
      cloudSessionRecoveryLegacyStorageKey(second.gatewayUrl, second.recoveryScope),
    );

    expect(writeCloudSessionRecovery(first)).toBe(true);
    expect(writeCloudSessionRecovery(second)).toBe(true);
    expect(listCloudSessionRecoveries(first.gatewayUrl, first.recoveryScope)).toEqual([first]);
    expect(listCloudSessionRecoveries(second.gatewayUrl, second.recoveryScope)).toEqual([second]);
  });

  it("restores legacy bytes and exposes nothing when relocation exceeds quota", () => {
    const raw = `  ${JSON.stringify(recovery)}\n`;
    sessionStorage.setItem(legacyKey, raw);
    const storage = sessionStorage;
    const destination = exactKey(recovery.sessionKey);
    vi.stubGlobal("sessionStorage", {
      get length() {
        return storage.length;
      },
      getItem: storage.getItem.bind(storage),
      key: storage.key.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      setItem: vi.fn((key: string, value: string) => {
        if (key === destination) {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        }
        storage.setItem(key, value);
      }),
    });

    expect(listCloudSessionRecoveries(recovery.gatewayUrl, recovery.recoveryScope)).toEqual([]);
    expect(storage.getItem(legacyKey)).toBe(raw);
    expect(storage.getItem(destination)).toBeNull();
    expect(
      readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope, recovery.sessionKey),
    ).toBeNull();
    expect(storage.getItem(legacyKey)).toBe(raw);
    expect(storage.getItem(destination)).toBeNull();
  });

  it("fails closed when storage is unavailable", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(),
      removeItem: vi.fn(),
      setItem: vi.fn(() => {
        throw new DOMException("storage disabled", "SecurityError");
      }),
    });
    expect(writeCloudSessionRecovery(recovery)).toBe(false);
  });

  it("round-trips an attachment-only first turn", () => {
    const attachmentRecovery = {
      ...recovery,
      message: "",
      attachments: [{ type: "file", mimeType: "text/plain", content: "aGVsbG8=" }],
    };
    expect(writeCloudSessionRecovery(attachmentRecovery)).toBe(true);
    expect(
      readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope, recovery.sessionKey),
    ).toEqual(attachmentRecovery);
  });

  it("requires matching create parameters for a creating recovery", () => {
    const creating = {
      ...recovery,
      phase: "creating" as const,
      createParams: {
        key: recovery.sessionKey,
        agentId: "cloud",
        message: "" as const,
        category: "Client work",
        projectId: "openclaw",
        thinkingLevel: "high",
        visibility: "draft" as const,
        worktree: true as const,
      },
    };
    expect(writeCloudSessionRecovery(creating)).toBe(true);
    expect(
      readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope, recovery.sessionKey),
    ).toEqual(creating);

    sessionStorage.setItem(
      exactKey(recovery.sessionKey),
      JSON.stringify({ ...creating, createParams: { key: "agent:cloud:other" } }),
    );
    expect(
      readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope, recovery.sessionKey),
    ).toBeNull();
  });

  it.each([
    { name: "an empty project id", value: { projectId: "" } },
    { name: "a non-string project id", value: { projectId: 42 } },
    { name: "an unsupported visibility", value: { visibility: "shared" } },
    { name: "an unknown field", value: { unknown: true } },
  ])("rejects $name in creating parameters", ({ value }) => {
    expect(
      parseCloudSessionCreateParams(
        {
          key: recovery.sessionKey,
          agentId: "cloud",
          message: "",
          worktree: true,
          ...value,
        },
        recovery.sessionKey,
        "cloud",
      ),
    ).toBeNull();
  });

  it("does not let stale cleanup erase another session", () => {
    expect(writeCloudSessionRecovery(recovery)).toBe(true);
    clearCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope, "agent:cloud:older");
    expect(
      readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope, recovery.sessionKey),
    ).toEqual(recovery);
  });

  it("arbitrates matching sessions without blocking another session", () => {
    expect(writeCloudSessionRecoveryIfAvailable(recovery)).toBe(true);
    expect(writeCloudSessionRecoveryIfAvailable({ ...recovery, message: "retry" })).toBe(true);
    expect(
      writeCloudSessionRecoveryIfAvailable({
        ...recovery,
        messageId: "message-conflict",
        message: "conflicting task",
      }),
    ).toBe(false);
    const second = {
      ...recovery,
      sessionKey: "agent:cloud:newer",
      messageId: "message-newer",
    };
    expect(writeCloudSessionRecoveryIfAvailable(second)).toBe(true);
    expect(listCloudSessionRecoveries(recovery.gatewayUrl, recovery.recoveryScope)).toEqual([
      second,
      { ...recovery, message: "retry" },
    ]);
  });
});
