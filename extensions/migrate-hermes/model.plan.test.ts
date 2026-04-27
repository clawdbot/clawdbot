import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it } from "vitest";
import { HERMES_REASON_DEFAULT_MODEL_CONFIGURED } from "./items.js";
import { buildHermesMigrationProvider } from "./provider.js";
import { cleanupTempRoots, makeContext, makeTempRoot, writeFile } from "./test/provider-helpers.js";

describe("Hermes migration model planning", () => {
  afterEach(async () => {
    await cleanupTempRoots();
  });

  it("preserves the provider for top-level string model refs", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await writeFile(path.join(source, "config.yaml"), "provider: openai\nmodel: gpt-5.4\n");

    const provider = buildHermesMigrationProvider();
    const plan = await provider.plan(makeContext({ source, stateDir, workspaceDir }));

    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "config:default-model",
          details: { model: "openai/gpt-5.4" },
          status: "planned",
        }),
      ]),
    );
  });

  it("treats existing object-form default model primaries as conflicts", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await writeFile(
      path.join(source, "config.yaml"),
      "model:\n  provider: openai\n  model: gpt-5.4\n",
    );

    const provider = buildHermesMigrationProvider();
    const plan = await provider.plan(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        model: {
          primary: "anthropic/claude-sonnet-4.6",
          fallbacks: ["openai/gpt-5.4"],
          timeoutMs: 120_000,
        },
      }),
    );

    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "config:default-model",
          status: "conflict",
          reason: HERMES_REASON_DEFAULT_MODEL_CONFIGURED,
        }),
      ]),
    );
  });

  it("treats default-agent model overrides as conflicts", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await writeFile(
      path.join(source, "config.yaml"),
      "model:\n  provider: openai\n  model: gpt-5.4\n",
    );
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          model: "openai/gpt-5.4",
        },
        list: [
          {
            id: "main",
            default: true,
            model: "anthropic/claude-sonnet-4.6",
          },
        ],
      },
    } as OpenClawConfig;

    const provider = buildHermesMigrationProvider();
    const plan = await provider.plan(makeContext({ source, stateDir, workspaceDir, config }));

    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "config:default-model",
          status: "conflict",
          reason: HERMES_REASON_DEFAULT_MODEL_CONFIGURED,
        }),
      ]),
    );
  });
});
