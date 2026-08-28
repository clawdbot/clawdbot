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
    ["extra field", { unexpected: true }],
    ["unpinned verification URI", { verificationUri: "https://example.test" }],
    ["oversized lifetime", { expiresAtMs: deviceRecord.expiresAtMs + 1 }],
    ["noncanonical agent", { agentId: " Main " }],
    ["invalid device code", { deviceCode: "secret" }],
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
