import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { commitConfigWithPendingPluginInstalls } from "./install-record-commit.js";

describe("committed plugin configuration", () => {
  it.each([false, true])(
    "returns the persisted configuration (pending records: %s)",
    async (pending) => {
      await withOpenClawTestState({ label: "committed-plugin-config" }, async (state) => {
        await state.writeConfig({ gateway: { mode: "local" } });
        const nextConfig: OpenClawConfig = {
          gateway: { mode: "local" },
          ...(pending
            ? {
                plugins: {
                  installs: { fixture: { source: "npm" as const, spec: "fixture@1.0.0" } },
                },
              }
            : {}),
        };

        const result = await commitConfigWithPendingPluginInstalls({ nextConfig });
        const persisted = JSON.parse(await fs.readFile(state.configPath, "utf8"));

        expect(result.path).toBe(state.configPath);
        expect(result.nextConfig).toEqual(persisted);
        expect(result.nextConfig.meta?.lastTouchedVersion).toEqual(expect.any(String));
        expect(result.movedInstallRecords).toBe(pending);
        expect(result.nextConfig.plugins?.installs).toBeUndefined();
      });
    },
  );
});
