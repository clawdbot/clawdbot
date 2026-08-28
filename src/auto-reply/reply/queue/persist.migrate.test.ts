import { describe, expect, it } from "vitest";
import { canMigrateFollowupQueueEntryLosslessly } from "./persist.js";
import {
  FOLLOWUP_PERSIST_TEST_KEY as TEST_KEY,
  createFollowupPersistTestRun as makeRun,
} from "./persist.test-helpers.js";

describe("canMigrateFollowupQueueEntryLosslessly", () => {
  function persistedRun(overrides: { sessionKey?: string } = {}) {
    return {
      prompt: "overflowed",
      enqueuedAt: Date.now(),
      originatingChannel: "telegram",
      originatingTo: "12345",
      run: {
        ...makeRun(),
        sessionKey: overrides.sessionKey ?? TEST_KEY,
      },
    };
  }

  it("rejects zero-count overflow that still carries summary sources", () => {
    expect(
      canMigrateFollowupQueueEntryLosslessly(TEST_KEY, {
        items: [],
        mode: "steer",
        droppedCount: 0,
        summaryLines: ["kept source"],
        summarySources: [persistedRun()],
      }),
    ).toBe(false);
  });

  it("rejects elision-only overflow at droppedCount 0", () => {
    expect(
      canMigrateFollowupQueueEntryLosslessly(TEST_KEY, {
        items: [],
        mode: "steer",
        droppedCount: 0,
        summaryLines: [],
        summaryElisions: [
          {
            contextKey: "route-a",
            count: 1,
            sources: [persistedRun()],
            summaryLines: ["elided"],
          },
        ],
      }),
    ).toBe(false);
  });

  it("rejects mismatched source/line accounting", () => {
    expect(
      canMigrateFollowupQueueEntryLosslessly(TEST_KEY, {
        items: [],
        mode: "steer",
        droppedCount: 2,
        summaryLines: ["only-one-line"],
        summarySources: [persistedRun(), persistedRun()],
      }),
    ).toBe(false);
  });

  it("accepts drainable overflow with matching droppedCount, sources, and lines", () => {
    expect(
      canMigrateFollowupQueueEntryLosslessly(TEST_KEY, {
        items: [],
        mode: "steer",
        droppedCount: 1,
        summaryLines: ["kept source"],
        summarySources: [persistedRun()],
      }),
    ).toBe(true);
  });

  it("rejects legacy entries that still carry memberRoleIds", () => {
    expect(
      canMigrateFollowupQueueEntryLosslessly(TEST_KEY, {
        items: [
          {
            prompt: "legacy-role",
            enqueuedAt: Date.now(),
            originatingChannel: "discord",
            originatingTo: "channel:ops",
            run: {
              ...makeRun(),
              sessionKey: TEST_KEY,
              memberRoleIds: ["operator"],
            },
          },
        ],
        mode: "steer",
        droppedCount: 0,
        summaryLines: [],
      }),
    ).toBe(false);
  });

  it("rejects intersection-only tool policy that cannot reattach an allowlist", () => {
    expect(
      canMigrateFollowupQueueEntryLosslessly(TEST_KEY, {
        items: [
          {
            ...persistedRun(),
            toolsAllowIntersection: [["exec"]],
          },
        ],
        mode: "steer",
        droppedCount: 0,
        summaryLines: [],
      }),
    ).toBe(false);
  });

  it("rejects Skill Workshop revision constraints that cannot be closed-validated", () => {
    expect(
      canMigrateFollowupQueueEntryLosslessly(TEST_KEY, {
        items: [
          {
            ...persistedRun(),
            run: {
              ...persistedRun().run,
              skillWorkshopProposalRevision: {
                agentId: "main",
                workspaceDir: "/tmp/workspace",
                proposalId: "proposal-h1",
                expectedRevisionHash: "not-a-revision-hash",
              },
            },
          },
        ],
        mode: "steer",
        droppedCount: 0,
        summaryLines: [],
      }),
    ).toBe(false);
  });

  it("rejects delegated-authority follow-ups that cannot restore a live claim", () => {
    expect(
      canMigrateFollowupQueueEntryLosslessly(TEST_KEY, {
        items: [
          {
            ...persistedRun(),
            delegatedAuthority: true,
          },
        ],
        mode: "steer",
        droppedCount: 0,
        summaryLines: [],
      }),
    ).toBe(false);
    expect(
      canMigrateFollowupQueueEntryLosslessly(TEST_KEY, {
        items: [
          {
            ...persistedRun(),
            run: {
              ...persistedRun().run,
              trustedInternalHandoff: { kind: "unknown" },
            },
          },
        ],
        mode: "steer",
        droppedCount: 0,
        summaryLines: [],
      }),
    ).toBe(false);
    expect(
      canMigrateFollowupQueueEntryLosslessly(TEST_KEY, {
        items: [
          {
            ...persistedRun(),
            run: {
              ...persistedRun().run,
              runtimePluginToolGrant: { pluginId: "workboard", toolNames: [""] },
            },
          },
        ],
        mode: "steer",
        droppedCount: 0,
        summaryLines: [],
      }),
    ).toBe(false);
    expect(
      canMigrateFollowupQueueEntryLosslessly(TEST_KEY, {
        items: [
          {
            ...persistedRun(),
            run: {
              ...persistedRun().run,
              terminalReplyExpectation: "maybe",
            },
          },
        ],
        mode: "steer",
        droppedCount: 0,
        summaryLines: [],
      }),
    ).toBe(false);
    expect(
      canMigrateFollowupQueueEntryLosslessly(TEST_KEY, {
        items: [
          {
            ...persistedRun(),
            run: {
              ...persistedRun().run,
              inputProvenance: { kind: "forged" },
            },
          },
        ],
        mode: "steer",
        droppedCount: 0,
        summaryLines: [],
      }),
    ).toBe(false);
  });
});
