import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it } from "vitest";
import { HERMES_REASON_DEFAULT_MODEL_CONFIGURED } from "./items.js";
import { buildHermesMigrationProvider } from "./provider.js";
import {
  cleanupTempRoots,
  makeConfigRuntime,
  makeContext,
  makeTempRoot,
  writeFile,
} from "./test/provider-helpers.js";

describe("Hermes migration model apply", () => {
  afterEach(async () => {
    await cleanupTempRoots();
  });

  it("updates only the primary model when applying over object-form model config", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    await writeFile(
      path.join(source, "config.yaml"),
      "model:\n  provider: openai\n  model: gpt-5.4\n",
    );
    const existingConfig = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          model: {
            primary: "anthropic/claude-sonnet-4.6",
            fallbacks: ["openrouter/anthropic/claude-opus-4.6"],
            timeoutMs: 120_000,
          },
        },
      },
    } as OpenClawConfig;
    let writtenConfig: OpenClawConfig | undefined;
    const provider = buildHermesMigrationProvider({
      runtime: makeConfigRuntime(existingConfig, (next) => {
        writtenConfig = next;
      }),
    });

    const result = await provider.apply(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        overwrite: true,
        model: existingConfig.agents?.defaults?.model,
        reportDir,
      }),
    );

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "config:default-model",
          status: "migrated",
        }),
      ]),
    );
    expect(writtenConfig?.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.4",
      fallbacks: ["openrouter/anthropic/claude-opus-4.6"],
      timeoutMs: 120_000,
    });
  });

  it("updates the default-agent model override when applying with overwrite", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    await writeFile(
      path.join(source, "config.yaml"),
      "model:\n  provider: openai\n  model: gpt-5.4\n",
    );
    const existingConfig = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          model: {
            primary: "google/gemini-3-pro",
            fallbacks: ["openai/gpt-5.4"],
          },
        },
        list: [
          {
            id: "main",
            default: true,
            model: {
              primary: "anthropic/claude-sonnet-4.6",
              fallbacks: ["openrouter/anthropic/claude-opus-4.6"],
            },
          },
        ],
      },
    } as OpenClawConfig;
    let writtenConfig: OpenClawConfig | undefined;
    const provider = buildHermesMigrationProvider({
      runtime: makeConfigRuntime(existingConfig, (next) => {
        writtenConfig = next;
      }),
    });

    const result = await provider.apply(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        config: existingConfig,
        overwrite: true,
        reportDir,
      }),
    );

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "config:default-model",
          status: "migrated",
        }),
      ]),
    );
    expect(writtenConfig?.agents?.list?.[0]?.model).toEqual({
      primary: "openai/gpt-5.4",
      fallbacks: ["openrouter/anthropic/claude-opus-4.6"],
    });
    expect(writtenConfig?.agents?.defaults?.model).toEqual(existingConfig.agents?.defaults?.model);
  });

  it("reports late-created default models as conflicts without overwriting", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    await writeFile(
      path.join(source, "config.yaml"),
      "model:\n  provider: openai\n  model: gpt-5.4\n",
    );
    const lateConfig = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          model: "anthropic/claude-sonnet-4.6",
        },
      },
    } as OpenClawConfig;
    const provider = buildHermesMigrationProvider({
      runtime: makeConfigRuntime(lateConfig),
    });
    const ctx = makeContext({ source, stateDir, workspaceDir, reportDir });
    const plan = await provider.plan(ctx);

    const result = await provider.apply(ctx, plan);

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "config:default-model",
          status: "conflict",
          reason: HERMES_REASON_DEFAULT_MODEL_CONFIGURED,
        }),
      ]),
    );
    expect(result.summary.conflicts).toBe(1);
    expect(lateConfig.agents?.defaults?.model).toBe("anthropic/claude-sonnet-4.6");
  });
});
