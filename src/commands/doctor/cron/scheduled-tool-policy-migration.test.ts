import { describe, expect, it } from "vitest";
import { formatScheduledToolPolicyAdvisory } from "./repair-plan.js";
import { normalizeStoredCronJobs } from "./store-migration.js";

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "legacy",
    name: "Legacy",
    enabled: true,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    owner: {
      agentId: "main",
      sessionKey: "agent:main:discord:group:ops",
      accountId: "work",
    },
    payload: { kind: "agentTurn", message: "run", toolsAllow: ["write"] },
    ...overrides,
  };
}

describe("migrateScheduledToolPolicy", () => {
  it("recovers an account from the persisted owner pair", () => {
    const raw = job();
    const result = normalizeStoredCronJobs([raw]);
    expect(result.issues.migratedScheduledToolPolicy).toBe(1);
    expect(raw.scheduledToolPolicy).toEqual({
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:discord:group:ops",
      ownerAccountId: "work",
    });
  });

  it("recovers an account structurally encoded in a direct-session key", () => {
    const raw = job({
      owner: {
        agentId: "main",
        sessionKey: "agent:main:discord:work:direct:user-1",
      },
    });
    const result = normalizeStoredCronJobs([raw]);
    expect(result.issues.migratedScheduledToolPolicy).toBe(1);
    expect(raw.owner).toMatchObject({ accountId: "work" });
  });

  it.each([
    {
      label: "agent mismatch",
      owner: {
        agentId: "other",
        sessionKey: "agent:main:discord:work:direct:user-1",
        accountId: "work",
      },
    },
    {
      label: "encoded account mismatch",
      owner: {
        agentId: "main",
        sessionKey: "agent:main:discord:work:direct:user-1",
        accountId: "personal",
      },
    },
    {
      label: "accountless owner",
      owner: { agentId: "main", sessionKey: "agent:main:discord:group:ops" },
    },
  ])("does not guess authority for $label", ({ owner }) => {
    const raw = job({ owner });
    const result = normalizeStoredCronJobs([raw]);
    expect(result.legacyScheduledToolPolicyJobs).toEqual(["Legacy"]);
    expect(raw.scheduledToolPolicy).toBeUndefined();
  });

  it("keeps capless historical jobs on legacy sender policy", () => {
    const raw = job({ payload: { kind: "agentTurn", message: "run" } });
    const result = normalizeStoredCronJobs([raw]);
    expect(result.legacyScheduledToolPolicyJobs).toEqual(["Legacy"]);
  });

  it("rejects malformed and owner-inconsistent provenance", () => {
    const malformed = job({ scheduledToolPolicy: { version: 2, mode: "trusted" } });
    expect(normalizeStoredCronJobs([malformed]).invalidScheduledToolPolicyJobs).toEqual(["Legacy"]);

    const inconsistent = job({
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:discord:group:ops",
        ownerAccountId: "personal",
      },
    });
    expect(normalizeStoredCronJobs([inconsistent]).invalidScheduledToolPolicyJobs).toEqual([
      "Legacy",
    ]);
  });

  it("preserves valid trusted provenance", () => {
    const raw = job({ scheduledToolPolicy: { version: 1, mode: "trusted" } });
    const result = normalizeStoredCronJobs([raw]);
    expect(result.legacyScheduledToolPolicyJobs).toEqual([]);
    expect(result.invalidScheduledToolPolicyJobs).toEqual([]);
    expect(raw.scheduledToolPolicy).toEqual({ version: 1, mode: "trusted" });
  });

  it("reports auto-recoverable and ambiguous jobs through the doctor result", () => {
    const recoverable = job();
    const ambiguous = job({
      id: "ambiguous",
      name: "Ambiguous",
      owner: { agentId: "main", sessionKey: "agent:main:discord:group:ops" },
    });
    const result = normalizeStoredCronJobs([recoverable, ambiguous]);

    expect(result.issues.migratedScheduledToolPolicy).toBe(1);
    expect(result.legacyScheduledToolPolicyJobs).toEqual(["Ambiguous"]);
    expect(
      formatScheduledToolPolicyAdvisory({
        legacyJobs: result.legacyScheduledToolPolicyJobs,
        invalidJobs: result.invalidScheduledToolPolicyJobs,
      }),
    ).toContain("openclaw cron edit <id> --tools");
  });
});
