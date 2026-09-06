import { beforeEach, describe, expect, it, vi } from "vitest";

const hiddenStore = vi.hoisted(() => ({ records: new Map<string, string>() }));

vi.mock("../secrets/store/secret-store.js", () => ({
  deleteHiddenGitHubSecretRecord: ({ name }: { name: string }) => hiddenStore.records.delete(name),
  listHiddenGitHubSecretRecordNames: ({ prefix }: { prefix: string }) =>
    [...hiddenStore.records.keys()].filter((name) => name.startsWith(`${prefix}-`)).toSorted(),
  readHiddenGitHubSecretRecord: ({ name }: { name: string }) => hiddenStore.records.get(name),
  writeHiddenGitHubSecretRecord: ({ name, value }: { name: string; value: string }) =>
    hiddenStore.records.set(name, value),
}));

import {
  deleteGitHubDeviceAuthorizationRecord,
  deleteGitHubOAuthRecord,
  inspectGitHubOAuthRecord,
  listGitHubDeviceAuthorizationRecords,
  listGitHubOAuthRecords,
  readGitHubDeviceAuthorizationRecord,
  writeGitHubDeviceAuthorizationRecord,
  writeGitHubOAuthRecord,
  type GitHubDeviceAuthorizationRecord,
  type GitHubOAuthRecord,
} from "./github-oauth-records.js";

const requestId = `github-device-${"1".repeat(32)}`;
const profileId = `ghp_${"2".repeat(32)}`;
const now = Date.parse("2026-08-19T12:00:00.000Z");

const deviceRecord: GitHubDeviceAuthorizationRecord = {
  version: 1,
  requestId,
  deviceCode: "a".repeat(40),
  userCode: "ABCD-EFGH",
  verificationUri: "https://github.com/login/device",
  createdAtMs: now,
  expiresAtMs: now + 15 * 60_000,
  pollIntervalMs: 5_000,
  nextPollAtMs: now + 5_000,
  agentId: "main",
  scope: "agent",
  expectedIdentity: null,
  agentLifecycleBinding: {
    agentId: "main",
    provenance: null,
  },
};

const oauthRecord: GitHubOAuthRecord = {
  version: 1,
  profileId,
  agentId: "main",
  scope: "agent",
  accountId: 3803641,
  login: "roboclaw-bot",
  refreshToken: "refresh-token-secret",
  accessExpiresAtMs: now + 8 * 60 * 60_000,
  refreshExpiresAtMs: now + 180 * 24 * 60 * 60_000,
  scopes: ["offline_access", "repo", "workflow"],
  createdAtMs: now,
};

describe("GitHub OAuth hidden records", () => {
  beforeEach(() => hiddenStore.records.clear());

  it("round-trips exact pending and refresh records under opaque hidden names", () => {
    writeGitHubDeviceAuthorizationRecord(deviceRecord);
    writeGitHubOAuthRecord(oauthRecord);

    expect([...hiddenStore.records.keys()]).toEqual([
      requestId,
      `github-oauth-${profileId.slice("ghp_".length)}`,
    ]);
    expect(listGitHubDeviceAuthorizationRecords()).toEqual([{ requestId, record: deviceRecord }]);
    expect(listGitHubOAuthRecords()).toEqual([{ profileId, record: oauthRecord }]);
    expect(readGitHubDeviceAuthorizationRecord(requestId)).toEqual(deviceRecord);
    expect(inspectGitHubOAuthRecord(profileId)).toEqual({ state: "valid", record: oauthRecord });
    expect(JSON.stringify([...hiddenStore.records.keys()])).not.toContain("refresh-token-secret");
    expect(JSON.stringify([...hiddenStore.records.keys()])).not.toContain(deviceRecord.deviceCode);

    deleteGitHubDeviceAuthorizationRecord(requestId);
    deleteGitHubOAuthRecord(profileId);
    expect(hiddenStore.records.size).toBe(0);
  });

  it.each([
    { name: "  Original Author  " },
    { email: "  original@example.test  " },
    { name: "Original", email: "original@example.test" },
  ])("preserves persisted Git author bytes %#", (gitAuthor) => {
    const record = {
      ...deviceRecord,
      expectedIdentity: { profileId, kind: "oauth" as const, gitAuthor },
    };
    writeGitHubDeviceAuthorizationRecord(record);
    expect(readGitHubDeviceAuthorizationRecord(requestId)).toEqual(record);
  });

  it.each(["record", "identity", "author", "binding", "provenance"] as const)(
    "rejects an own __proto__ key in the persisted %s",
    (location) => {
      const record = {
        ...deviceRecord,
        expectedIdentity: { profileId, gitAuthor: { name: "Name" } },
        agentLifecycleBinding: {
          agentId: "main",
          provenance: {
            agentId: "main",
            createdVia: "operator",
            creatorAgentId: null,
            createdAtMs: now,
          },
        },
      };
      const target =
        location === "record"
          ? record
          : location === "identity"
            ? record.expectedIdentity
            : location === "author"
              ? record.expectedIdentity.gitAuthor
              : location === "binding"
                ? record.agentLifecycleBinding
                : record.agentLifecycleBinding.provenance;
      Object.defineProperty(target, "__proto__", { value: null, enumerable: true });
      hiddenStore.records.set(requestId, JSON.stringify(record));
      expect(readGitHubDeviceAuthorizationRecord(requestId)).toBeUndefined();
    },
  );

  it.each([null, { agentId: "main", provenance: null, extra: true }])(
    "preserves System record reads that discard an invalid agent binding: %j",
    (agentLifecycleBinding) => {
      const { agentLifecycleBinding: _binding, ...unboundDevice } = deviceRecord;
      const expected = { ...unboundDevice, scope: "system" };
      hiddenStore.records.set(requestId, JSON.stringify({ ...expected, agentLifecycleBinding }));
      expect(readGitHubDeviceAuthorizationRecord(requestId)).toStrictEqual(expected);
      const pendingInitial = {
        requestId,
        scope: "system",
        agentId: "main",
        expectedIdentity: null,
      };
      hiddenStore.records.set(
        `github-oauth-${profileId.slice("ghp_".length)}`,
        JSON.stringify({
          ...oauthRecord,
          scope: "system",
          pendingInitial: { ...pendingInitial, agentLifecycleBinding },
        }),
      );
      expect(inspectGitHubOAuthRecord(profileId)).toStrictEqual({
        state: "valid",
        record: { ...oauthRecord, scope: "system", pendingInitial },
      });
    },
  );

  it.each([
    ["extra field", { unexpected: true }],
    ["unpinned verification URI", { verificationUri: "https://example.test" }],
    ["oversized lifetime", { expiresAtMs: deviceRecord.expiresAtMs + 1 }],
    ["noncanonical agent", { agentId: " Main " }],
    ["invalid device code", { deviceCode: "secret" }],
    ["UUID request", { requestId: "11111111-1111-4111-8111-111111111111" }],
    ["null lifecycle binding", { agentLifecycleBinding: null }],
    ["missing lifecycle binding", { agentLifecycleBinding: undefined }],
    ["system lifecycle binding", { scope: "system" }],
    ["foreign lifecycle agent", { agentLifecycleBinding: { agentId: "other", provenance: null } }],
    [
      "foreign provenance agent",
      {
        agentLifecycleBinding: {
          agentId: "main",
          provenance: {
            agentId: "other",
            createdVia: "operator",
            creatorAgentId: null,
            createdAtMs: now,
          },
        },
      },
    ],
    ["empty Git author", { expectedIdentity: { profileId, gitAuthor: {} } }],
    ["blank Git author", { expectedIdentity: { profileId, gitAuthor: { name: "  " } } }],
    [
      "extra Git author field",
      { expectedIdentity: { profileId, gitAuthor: { name: "Name", extra: true } } },
    ],
    ["missing identity snapshot", { expectedIdentity: undefined }],
    ["poll before creation", { nextPollAtMs: now - 1 }],
    ["poll after expiry", { nextPollAtMs: deviceRecord.expiresAtMs + 1 }],
    ["fractional timestamp", { createdAtMs: now + 0.5 }],
    ["unsafe timestamp", { nextPollAtMs: Number.MAX_SAFE_INTEGER + 1 }],
    ["zero lifetime", { expiresAtMs: now }],
  ])("rejects a pending record with %s", (_label, overrides) => {
    const value = structuredClone(deviceRecord);
    Object.assign(value, overrides);
    expect(() => writeGitHubDeviceAuthorizationRecord(value)).toThrow();
  });

  it.each([
    ["extra field", { ...oauthRecord, unexpected: true }],
    ["newline-bearing refresh token", { ...oauthRecord, refreshToken: "secret\nleak" }],
    ["unsorted scopes", { ...oauthRecord, scopes: ["repo", "offline_access", "workflow"] }],
    ["duplicate scopes", { ...oauthRecord, scopes: ["repo", "repo"] }],
    ["invalid login", { ...oauthRecord, login: "-robot" }],
    ["trailing login hyphen", { ...oauthRecord, login: "robot-" }],
    ["null pending initial", { ...oauthRecord, pendingInitial: null }],
    ["false pending refresh", { ...oauthRecord, pendingRefresh: false }],
    ["null refresh failure", { ...oauthRecord, refreshFailure: null }],
    ["access expiry at creation", { ...oauthRecord, accessExpiresAtMs: now }],
    [
      "too many scopes",
      { ...oauthRecord, scopes: Array.from({ length: 33 }, (_, i) => `scope${i}`).toSorted() },
    ],
    [
      "access expiry after refresh",
      { ...oauthRecord, accessExpiresAtMs: oauthRecord.refreshExpiresAtMs },
    ],
    [
      "both pending-initial and pending-refresh markers",
      {
        ...oauthRecord,
        pendingInitial: {
          requestId,
          scope: "agent",
          agentId: "main",
          expectedIdentity: null,
          agentLifecycleBinding: { agentId: "main", provenance: null },
        },
        pendingRefresh: true,
      },
    ],
    [
      "pending-initial scope mismatch",
      {
        ...oauthRecord,
        pendingInitial: {
          requestId,
          scope: "system",
          agentId: "main",
          expectedIdentity: null,
        },
      },
    ],
    [
      "pending refresh with terminal failure",
      { ...oauthRecord, pendingRefresh: true, refreshFailure: "expired" },
    ],
  ])("rejects refresh metadata with %s", (_label, value) => {
    const candidate = structuredClone(oauthRecord);
    Object.assign(candidate, value);
    expect(() => writeGitHubOAuthRecord(candidate)).toThrow();
  });
});
