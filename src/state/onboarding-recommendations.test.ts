import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createOnboardingRecommendationsStore,
  type OnboardingRecommendationMatch,
} from "./onboarding-recommendations.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const matches: OnboardingRecommendationMatch[] = [
  {
    appLabel: "Chat",
    candidateId: "chat-plugin",
    tier: "recommended",
    reason: "Connects conversations",
    candidate: {
      id: "chat-plugin",
      displayName: "Chat plugin",
      summary: "Chat",
      source: "official-channel",
    },
  },
];

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("onboarding recommendations store", () => {
  it("isolates offers by workspace", async () => {
    await withOpenClawTestState({ label: "onboarding-recommendations-scopes" }, async (state) => {
      const database = { env: state.env };
      const workspaceA = createOnboardingRecommendationsStore({
        workspaceDir: state.path("workspace-a"),
        database,
      });
      const workspaceB = createOnboardingRecommendationsStore({
        workspaceDir: state.path("workspace-b"),
        database,
      });

      const written = workspaceA.writeOffer({
        inventory: [{ label: "Chat" }],
        matches,
        answered: false,
        nowMs: 1_234,
      });

      expect(workspaceB.read()).toBeNull();
      expect(workspaceB.acknowledge({ nowMs: 2_345 })).toBeNull();
      expect(workspaceA.read()).toEqual(written);
    });
  });

  it("round-trips the workspace offer and answer timestamps", async () => {
    await withOpenClawTestState({ label: "onboarding-recommendations" }, async (state) => {
      const database = { env: state.env };
      const store = createOnboardingRecommendationsStore({
        workspaceDir: state.workspaceDir,
        database,
      });
      const inventory = [{ label: "Chat", bundleId: "com.example.chat" }];

      expect(store.read()).toBeNull();
      expect(fs.existsSync(state.statePath("state", "openclaw.sqlite"))).toBe(false);
      const written = store.writeOffer({
        inventory,
        matches,
        answered: true,
        nowMs: 1_234,
      });

      expect(written).toEqual({
        inventoryHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        matches,
        offeredAt: 1_234,
        acceptedAt: 1_234,
        updatedAt: 1_234,
      });
      expect(store.read()).toEqual(written);

      const staleCompletion = store.writeOffer({
        inventory: [{ label: "Different" }],
        matches: [],
        answered: false,
        nowMs: 2_000,
      });
      expect(staleCompletion).toEqual(written);
    });
  });

  it("keeps acceptedAt null when the offer was shown without an answer", async () => {
    await withOpenClawTestState({ label: "onboarding-recommendations-open" }, async (state) => {
      const store = createOnboardingRecommendationsStore({
        workspaceDir: state.workspaceDir,
        database: { env: state.env },
      });
      const record = store.writeOffer({
        inventory: [{ label: "Chat" }],
        matches,
        answered: false,
        nowMs: 2_345,
      });

      expect(record.acceptedAt).toBeNull();

      const acknowledged = store.acknowledge({
        nowMs: 3_456,
      });
      expect(acknowledged).toEqual({ ...record, acceptedAt: 3_456, updatedAt: 3_456 });
      expect(store.read()).toEqual(acknowledged);
    });
  });

  it("updates pending matches without changing the inventory identity", async () => {
    await withOpenClawTestState({ label: "onboarding-recommendations-retry" }, async (state) => {
      const database = { env: state.env };
      const store = createOnboardingRecommendationsStore({
        workspaceDir: state.workspaceDir,
        database,
      });
      const record = store.writeOffer({
        inventory: [{ label: "Chat" }, { label: "Notes" }],
        matches,
        answered: false,
        nowMs: 2_000,
      });
      const retryMatch = { ...matches[0]!, reason: "Retry this install" };

      const updated = store.updatePending({
        matches: [retryMatch],
        expected: record,
        nowMs: 3_000,
      });

      expect(updated).toEqual({
        ...record,
        matches: [retryMatch],
        updatedAt: 3_000,
      });
      expect(updated?.inventoryHash).toBe(record.inventoryHash);
    });
  });

  it("does not overwrite a concurrently replaced pending offer", async () => {
    await withOpenClawTestState({ label: "onboarding-recommendations-stale" }, async (state) => {
      const database = { env: state.env };
      const store = createOnboardingRecommendationsStore({
        workspaceDir: state.workspaceDir,
        database,
      });
      const original = store.writeOffer({
        inventory: [{ label: "Chat" }],
        matches,
        answered: false,
        nowMs: 2_000,
      });
      const replacement = store.writeOffer({
        inventory: [{ label: "Notes" }],
        matches: [],
        answered: false,
        nowMs: 2_500,
      });

      expect(
        store.updatePending({
          matches,
          expected: original,
          nowMs: 3_000,
        }),
      ).toBeNull();
      expect(
        store.acknowledge({
          expected: original,
          nowMs: 3_000,
        }),
      ).toBeNull();
      expect(store.read()).toEqual(replacement);
    });
  });

  it("clears only pending offers", async () => {
    await withOpenClawTestState(
      { label: "onboarding-recommendations-pending-clear" },
      async (state) => {
        const database = { env: state.env };
        const store = createOnboardingRecommendationsStore({
          workspaceDir: state.workspaceDir,
          database,
        });
        const pending = store.writeOffer({
          inventory: [{ label: "Chat" }],
          matches,
          answered: false,
        });

        expect(store.clearPending({ expected: pending })).toBe(true);
        expect(store.read()).toBeNull();

        const accepted = store.writeOffer({
          inventory: [{ label: "Chat" }],
          matches,
          answered: true,
        });
        expect(store.clearPending({ expected: accepted })).toBe(false);
        expect(store.read()?.acceptedAt).toBeTypeOf("number");
      },
    );
  });

  it("deletes the stored offer so recommendations can be scanned again", async () => {
    await withOpenClawTestState({ label: "onboarding-recommendations-clear" }, async (state) => {
      const database = { env: state.env };
      const store = createOnboardingRecommendationsStore({
        workspaceDir: state.workspaceDir,
        database,
      });
      store.writeOffer({
        inventory: [{ label: "Chat" }],
        matches,
        answered: true,
        nowMs: 4_567,
      });

      expect(store.clear()).toBe(true);
      expect(store.read()).toBeNull();
      expect(store.clear()).toBe(false);
    });
  });
});
