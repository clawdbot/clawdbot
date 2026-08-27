import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { readConfigMachineState, writeConfigMachineState } from "../state/config-machine-state.js";
import { createOnboardingRecommendationsStore } from "../state/onboarding-recommendations.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { migrateLegacyOnboardingRecommendationsScope } from "./state-migrations.onboarding-recommendations.js";

function insertRecommendationRow(params: {
  database: { env: NodeJS.ProcessEnv };
  configKey: string;
  inventoryHash: string;
}): void {
  writeConfigMachineState(
    `onboarding.recommendations.${params.configKey}`,
    {
      inventoryHash: params.inventoryHash,
      matches: [],
      offeredAt: 1_000,
      acceptedAt: 2_000,
      updatedAt: 2_000,
    },
    params.database,
  );
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("onboarding recommendations scope migration", () => {
  it("moves the legacy singleton row to the default workspace", async () => {
    await withOpenClawTestState(
      { label: "onboarding-recommendations-migration" },
      async (state) => {
        const database = { env: state.env };
        insertRecommendationRow({
          database,
          configKey: "primary",
          inventoryHash: "legacy-inventory",
        });

        const result = migrateLegacyOnboardingRecommendationsScope({
          cfg: {
            agents: {
              defaults: { workspace: state.workspaceDir },
              entries: { main: { default: true } },
            },
          } as OpenClawConfig,
          env: state.env,
        });

        expect(result).toEqual({
          changes: [
            "Migrated onboarding recommendation state to the legacy owner workspace scope.",
          ],
          warnings: [],
        });
        expect(
          createOnboardingRecommendationsStore({
            workspaceDir: state.workspaceDir,
            database,
          }).read(),
        ).toEqual({
          inventoryHash: "legacy-inventory",
          matches: [],
          offeredAt: 1_000,
          acceptedAt: 2_000,
          updatedAt: 2_000,
        });
        expect(
          readConfigMachineState("onboarding.recommendations.primary", database),
        ).toBeUndefined();
      },
    );
  });

  it("keeps an existing scoped row when legacy state is also present", async () => {
    await withOpenClawTestState(
      { label: "onboarding-recommendations-migration-conflict" },
      async (state) => {
        const database = { env: state.env };
        const store = createOnboardingRecommendationsStore({
          workspaceDir: state.workspaceDir,
          database,
        });
        const scoped = store.writeOffer({
          inventory: [{ label: "Scoped" }],
          matches: [],
          answered: false,
          nowMs: 3_000,
        });
        insertRecommendationRow({
          database,
          configKey: "primary",
          inventoryHash: "legacy-inventory",
        });

        const result = migrateLegacyOnboardingRecommendationsScope({
          cfg: {
            agents: {
              defaults: { workspace: state.workspaceDir },
              entries: { main: { default: true } },
            },
          } as OpenClawConfig,
          env: state.env,
        });

        expect(result).toEqual({
          changes: [
            "Removed ambiguous legacy onboarding recommendation state; kept the legacy owner workspace record.",
          ],
          warnings: [],
        });
        expect(store.read()).toEqual(scoped);
        expect(
          readConfigMachineState("onboarding.recommendations.primary", database),
        ).toBeUndefined();
      },
    );
  });
});
