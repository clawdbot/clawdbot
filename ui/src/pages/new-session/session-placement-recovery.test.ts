import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sessionPlacementRecoveryExactStorageKey,
  sessionPlacementRecoveryScopeStoragePrefix,
} from "../../lib/sessions/session-placement-recovery-storage-key.ts";
import {
  clearSessionPlacementRecovery,
  listSessionPlacementRecoveries,
  migrateSessionPlacementRecoveryScope,
  parseSessionPlacementCreateParams,
  pauseSessionPlacementRecovery,
  readSessionPlacementRecovery,
  writeSessionPlacementRecovery,
  writeSessionPlacementRecoveryIfAvailable,
} from "../../lib/sessions/session-placement-recovery.ts";

const recovery = {
  sessionKey: "agent:cloud:one",
  messageId: "message-1",
  message: "run remotely",
  target: { kind: "profile" as const, profileId: "aws" },
  agentId: "cloud",
  gatewayUrl: "ws://gateway.example",
  recoveryScope: "principal-a",
  phase: "dispatching" as const,
};

const exactKey = (sessionKey: string) =>
  sessionPlacementRecoveryExactStorageKey(recovery.gatewayUrl, recovery.recoveryScope, sessionKey);

describe("session placement recovery", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("frames every namespace component without URI encoding", () => {
    const gatewayUrl = "ws://gateway.example";
    const recoveryScope = "principal-a";
    const sessionKey = "admin";
    const scopePrefix = sessionPlacementRecoveryScopeStoragePrefix(gatewayUrl, recoveryScope);
    expect(scopePrefix).toBe(
      `openclaw.new-session.session-placement-recovery.v1:${gatewayUrl.length}:${gatewayUrl}:${recoveryScope.length}:${recoveryScope}:`,
    );
    expect(sessionPlacementRecoveryExactStorageKey(gatewayUrl, recoveryScope, sessionKey)).toBe(
      `${scopePrefix}${sessionKey.length}:${sessionKey}`,
    );
    const colonGateway = `${gatewayUrl}:principal-a`;
    expect(sessionPlacementRecoveryScopeStoragePrefix(colonGateway, "admin")).not.toBe(
      sessionPlacementRecoveryScopeStoragePrefix(gatewayUrl, "principal-a:admin"),
    );

    expect(sessionPlacementRecoveryExactStorageKey(gatewayUrl, recoveryScope, "\ud800")).not.toBe(
      sessionPlacementRecoveryExactStorageKey(gatewayUrl, recoveryScope, "\ud801"),
    );
  });

  it("keeps two recoveries in one scope independently readable and clearable", () => {
    const second = {
      ...recovery,
      sessionKey: "agent:cloud:two",
      messageId: "message-2",
      message: "run another task",
      target: { kind: "device" as const, deviceId: "device-1" },
    };
    expect(writeSessionPlacementRecovery(recovery)).toBe(true);
    expect(writeSessionPlacementRecovery(second)).toBe(true);
    expect(listSessionPlacementRecoveries(recovery.gatewayUrl, recovery.recoveryScope)).toEqual([
      recovery,
      second,
    ]);
    expect(
      readSessionPlacementRecovery(
        recovery.gatewayUrl,
        recovery.recoveryScope,
        recovery.sessionKey,
      ),
    ).toEqual(recovery);

    clearSessionPlacementRecovery(recovery.gatewayUrl, recovery.recoveryScope, recovery.sessionKey);
    expect(
      readSessionPlacementRecovery(
        recovery.gatewayUrl,
        recovery.recoveryScope,
        recovery.sessionKey,
      ),
    ).toBeNull();
    expect(
      readSessionPlacementRecovery(second.gatewayUrl, second.recoveryScope, second.sessionKey),
    ).toEqual(second);

    clearSessionPlacementRecovery(recovery.gatewayUrl, recovery.recoveryScope);
    expect(listSessionPlacementRecoveries(recovery.gatewayUrl, recovery.recoveryScope)).toEqual([]);
  });

  it("preserves automatic device selection across placement recovery", () => {
    const automatic = {
      ...recovery,
      target: { kind: "auto-device" as const },
    };
    expect(writeSessionPlacementRecovery(automatic)).toBe(true);
    expect(
      readSessionPlacementRecovery(
        automatic.gatewayUrl,
        automatic.recoveryScope,
        automatic.sessionKey,
      ),
    ).toEqual(automatic);
  });

  it("does not retire a replacement submission at the same session key", () => {
    const replacement = { ...recovery, messageId: "message-newer", message: "newer input" };
    expect(writeSessionPlacementRecovery(replacement)).toBe(true);
    clearSessionPlacementRecovery(
      recovery.gatewayUrl,
      recovery.recoveryScope,
      recovery.sessionKey,
      recovery.messageId,
    );
    expect(
      readSessionPlacementRecovery(
        recovery.gatewayUrl,
        recovery.recoveryScope,
        recovery.sessionKey,
      ),
    ).toEqual(replacement);
    clearSessionPlacementRecovery(
      recovery.gatewayUrl,
      recovery.recoveryScope,
      recovery.sessionKey,
      replacement.messageId,
    );
    expect(
      readSessionPlacementRecovery(
        recovery.gatewayUrl,
        recovery.recoveryScope,
        recovery.sessionKey,
      ),
    ).toBeNull();
  });

  it.each(["not-sent", "rejected", "unconfirmed"] as const)(
    "retains a paused %s failure without changing pending recovery or storage lifetime",
    (reason) => {
      const paused = {
        ...recovery,
        phase: "paused" as const,
        reason,
        error: "Target unavailable",
      };
      expect(writeSessionPlacementRecovery(paused)).toBe(true);
      expect(
        readSessionPlacementRecovery(
          recovery.gatewayUrl,
          recovery.recoveryScope,
          recovery.sessionKey,
        ),
      ).toEqual(paused);
      expect(writeSessionPlacementRecovery({ ...paused, error: "x".repeat(4097) })).toBe(false);
      expect(
        readSessionPlacementRecovery(
          recovery.gatewayUrl,
          recovery.recoveryScope,
          recovery.sessionKey,
        ),
      ).toEqual(paused);
    },
  );

  it.each([false, true])(
    "keeps input in memory on a failed pause write (already paused=%s)",
    (alreadyPaused) => {
      const retained = alreadyPaused
        ? {
            ...recovery,
            phase: "paused" as const,
            reason: "not-sent" as const,
            error: "first failure",
          }
        : recovery;
      expect(writeSessionPlacementRecovery(retained)).toBe(true);
      const storage = sessionStorage;
      vi.stubGlobal("sessionStorage", {
        getItem: storage.getItem.bind(storage),
        removeItem: storage.removeItem.bind(storage),
        setItem: () => {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        },
      });
      expect(pauseSessionPlacementRecovery(retained, "later failure", true)).toMatchObject({
        message: retained.message,
        messageId: retained.messageId,
        phase: "paused",
        reason: "not-sent",
        error: expect.stringContaining("Keep this page open"),
      });
      expect(
        readSessionPlacementRecovery(
          recovery.gatewayUrl,
          recovery.recoveryScope,
          recovery.sessionKey,
        ),
      ).toEqual(alreadyPaused ? retained : null);
    },
  );

  it("migrates only exact framed rows under a new scope", () => {
    const sourceScope = recovery.recoveryScope;
    const newScope = "gateway-principal";
    const second = {
      ...recovery,
      sessionKey: "agent:cloud:two",
      messageId: "message-2",
    };
    const unrelatedScope = { ...recovery, recoveryScope: "principal-other" };
    const unrelatedGateway = { ...recovery, gatewayUrl: "ws://other.example" };
    expect(writeSessionPlacementRecovery(recovery)).toBe(true);
    expect(writeSessionPlacementRecovery(second)).toBe(true);
    expect(writeSessionPlacementRecovery(unrelatedScope)).toBe(true);
    expect(writeSessionPlacementRecovery(unrelatedGateway)).toBe(true);

    migrateSessionPlacementRecoveryScope(recovery.gatewayUrl, sourceScope, newScope);

    expect(listSessionPlacementRecoveries(recovery.gatewayUrl, newScope)).toEqual([
      { ...recovery, recoveryScope: newScope },
      { ...second, recoveryScope: newScope },
    ]);
    expect(listSessionPlacementRecoveries(recovery.gatewayUrl, sourceScope)).toEqual([]);
    expect(
      listSessionPlacementRecoveries(unrelatedScope.gatewayUrl, unrelatedScope.recoveryScope),
    ).toEqual([unrelatedScope]);
    expect(listSessionPlacementRecoveries(unrelatedGateway.gatewayUrl, sourceScope)).toEqual([
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
    const destinationKey = sessionPlacementRecoveryExactStorageKey(
      recovery.gatewayUrl,
      newScope,
      recovery.sessionKey,
    );
    sessionStorage.setItem(sourceKey, sourceRaw);
    expect(writeSessionPlacementRecovery(destination)).toBe(true);

    migrateSessionPlacementRecoveryScope(recovery.gatewayUrl, recovery.recoveryScope, newScope);
    expect(sessionStorage.getItem(sourceKey)).toBe(sourceRaw);
    expect(
      readSessionPlacementRecovery(recovery.gatewayUrl, newScope, recovery.sessionKey),
    ).toEqual(destination);

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
    migrateSessionPlacementRecoveryScope(recovery.gatewayUrl, recovery.recoveryScope, newScope);
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
    migrateSessionPlacementRecoveryScope(recovery.gatewayUrl, recovery.recoveryScope, newScope);
    expect(storage.getItem(sourceKey)).toBe(sourceRaw);
    expect(
      readSessionPlacementRecovery(recovery.gatewayUrl, newScope, recovery.sessionKey),
    ).toEqual({
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
    expect(writeSessionPlacementRecovery(recovery)).toBe(true);
    expect(writeSessionPlacementRecovery(surrogateRecovery)).toBe(true);
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

    const listed = listSessionPlacementRecoveries(recovery.gatewayUrl, recovery.recoveryScope);
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining([recovery, surrogateRecovery]));
    expect(sessionStorage.getItem(exactKey(recovery.sessionKey))).not.toBeNull();
    expect(sessionStorage.getItem(exactKey(surrogateRecovery.sessionKey))).not.toBeNull();
    expect(sessionStorage.getItem(exactKey("agent:cloud:incognito"))).toBeNull();
    expect(sessionStorage.getItem(exactKey("agent:cloud:wrong-key"))).toBeNull();
    expect(sessionStorage.getItem(exactKey(invalidPayload.sessionKey))).toBeNull();
    expect(sessionStorage.getItem(malformedKey)).toBeNull();
  });

  it("fails closed when storage is unavailable", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(),
      removeItem: vi.fn(),
      setItem: vi.fn(() => {
        throw new DOMException("storage disabled", "SecurityError");
      }),
    });
    expect(writeSessionPlacementRecovery(recovery)).toBe(false);
  });

  it("round-trips an attachment-only first turn", () => {
    const attachmentRecovery = {
      ...recovery,
      message: "",
      attachments: [{ type: "file", mimeType: "text/plain", content: "aGVsbG8=" }],
    };
    expect(writeSessionPlacementRecovery(attachmentRecovery)).toBe(true);
    expect(
      readSessionPlacementRecovery(
        recovery.gatewayUrl,
        recovery.recoveryScope,
        recovery.sessionKey,
      ),
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
        toolOverrides: {
          mcpServers: { github: false },
          skills: { release: false },
          webSearch: false,
        },
        visibility: "draft" as const,
        worktree: true as const,
      },
    };
    expect(writeSessionPlacementRecovery(creating)).toBe(true);
    expect(
      readSessionPlacementRecovery(
        recovery.gatewayUrl,
        recovery.recoveryScope,
        recovery.sessionKey,
      ),
    ).toEqual(creating);

    sessionStorage.setItem(
      exactKey(recovery.sessionKey),
      JSON.stringify({ ...creating, createParams: { key: "agent:cloud:other" } }),
    );
    expect(
      readSessionPlacementRecovery(
        recovery.gatewayUrl,
        recovery.recoveryScope,
        recovery.sessionKey,
      ),
    ).toBeNull();
  });

  it.each([
    { name: "an empty project id", value: { projectId: "" } },
    { name: "a non-string project id", value: { projectId: 42 } },
    { name: "a project id with a cwd", value: { projectId: "openclaw", cwd: "/tmp/repo" } },
    {
      name: "a project id with an exec node",
      value: { projectId: "openclaw", execNode: "macbook" },
    },
    { name: "an unsupported visibility", value: { visibility: "shared" } },
    { name: "malformed tool overrides", value: { toolOverrides: { webSearch: "yes" } } },
    { name: "an unknown field", value: { unknown: true } },
  ])("rejects $name in creating parameters", ({ value }) => {
    expect(
      parseSessionPlacementCreateParams(
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
    expect(writeSessionPlacementRecovery(recovery)).toBe(true);
    clearSessionPlacementRecovery(recovery.gatewayUrl, recovery.recoveryScope, "agent:cloud:older");
    expect(
      readSessionPlacementRecovery(
        recovery.gatewayUrl,
        recovery.recoveryScope,
        recovery.sessionKey,
      ),
    ).toEqual(recovery);
  });

  it("arbitrates matching sessions without blocking another session", () => {
    expect(writeSessionPlacementRecoveryIfAvailable(recovery)).toBe(true);
    expect(writeSessionPlacementRecoveryIfAvailable({ ...recovery, message: "retry" })).toBe(true);
    expect(
      writeSessionPlacementRecoveryIfAvailable({
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
    expect(writeSessionPlacementRecoveryIfAvailable(second)).toBe(true);
    expect(listSessionPlacementRecoveries(recovery.gatewayUrl, recovery.recoveryScope)).toEqual([
      second,
      { ...recovery, message: "retry" },
    ]);
  });
});
