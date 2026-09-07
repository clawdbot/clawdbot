import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  mutateConfigFile,
  readConfigFileSnapshotForWrite,
} from "openclaw/plugin-sdk/config-mutation";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { createMatrixCliAccountConfigPublisher } from "./cli-shared.js";
import { updateMatrixAccountConfig } from "./matrix/config-update.js";

vi.mock("./runtime.js", () => ({
  getMatrixRuntime: () => ({ config: { current: getRuntimeConfig, mutateConfigFile } }),
}));

afterEach(clearRuntimeConfigSnapshot);

it.each(["paired resolved", "unpaired", "paired replaced"])(
  "protects account publication with %s canonical config state",
  async (mode) => {
    await withTempHome(
      async (home) => {
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        const source = {
          channels: {
            matrix: {
              homeserver: "https://matrix.example.org",
              accessToken: { source: "env", provider: "default", id: "MATRIX_TEST_SECRET" },
            },
          },
        } satisfies OpenClawConfig;
        await fs.writeFile(configPath, JSON.stringify(source));
        const { snapshot } = await readConfigFileSnapshotForWrite();
        expect(snapshot.valid).toBe(true);
        const runtime = structuredClone(snapshot.runtimeConfig);
        if (mode !== "unpaired") {
          runtime.channels = {
            ...runtime.channels,
            matrix: {
              ...source.channels?.matrix,
              accessToken: "synthetic-resolved-token",
            },
          };
          setRuntimeConfigSnapshot(runtime, snapshot.sourceConfig);
        } else {
          setRuntimeConfigSnapshot(runtime);
        }

        const publishConfig = createMatrixCliAccountConfigPublisher({
          accountId: "default",
          previousCfg: getRuntimeConfig(),
        });
        if (mode === "paired replaced") {
          await mutateConfigFile({
            afterWrite: { mode: "auto" },
            mutate: (draft) => {
              draft.channels = updateMatrixAccountConfig(draft, "default", {
                accessToken: "replacement-token",
              }).channels;
            },
          });
          await expect(
            publishConfig((cfg) => updateMatrixAccountConfig(cfg, "default", { encryption: true })),
          ).rejects.toThrow("changed during setup");
          const persisted = JSON.parse(await fs.readFile(configPath, "utf8"));
          expect(persisted.channels.matrix.accessToken).toBe("replacement-token");
          expect(persisted.channels.matrix.encryption).not.toBe(true);
          return;
        }
        await publishConfig((cfg) =>
          updateMatrixAccountConfig(cfg, "default", { encryption: true }),
        );

        const persisted = JSON.parse(await fs.readFile(configPath, "utf8"));
        expect(persisted.channels.matrix.accessToken).toEqual(source.channels?.matrix?.accessToken);
        expect(persisted.channels.matrix.encryption).toBe(true);
      },
      {
        env: {
          OPENCLAW_CONFIG_PATH: (home) => path.join(home, ".openclaw", "openclaw.json"),
          MATRIX_TEST_SECRET: "synthetic-resolved-token",
        },
      },
    );
  },
);
