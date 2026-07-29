// Non-interactive migration tests exercise the real staged import and terminal acknowledgement.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { summarizeMigrationItems } from "../plugin-sdk/migration.js";
import type { MigrationApplyResult, MigrationPlan } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
const configStore = new Map<string, OpenClawConfig>();
const ensureWorkspaceAndSessions = vi.hoisted(() => vi.fn(async () => {}));
const provider = vi.hoisted(() => ({
  id: "hermes",
  label: "Hermes",
  description: "Hermes migration provider",
  plan: vi.fn(),
  apply: vi.fn(),
}));
let previousStateDir: string | undefined;

function configPath(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required");
  }
  return path.join(stateDir, "openclaw.json");
}

vi.mock("../config/io.js", () => ({
  readConfigFileSnapshot: async () => {
    const config = configStore.get(configPath());
    return config
      ? {
          exists: true,
          valid: true,
          config,
          sourceConfig: config,
          raw: `${JSON.stringify(config)}\n`,
          hash: "test-config-hash",
        }
      : {
          exists: false,
          valid: true,
          config: {},
          sourceConfig: {},
          raw: null,
          hash: undefined,
        };
  },
}));

vi.mock("../config/config.js", () => ({
  ConfigMutationConflictError: class ConfigMutationConflictError extends Error {},
  replaceConfigFile: async ({ nextConfig }: { nextConfig: OpenClawConfig }) => {
    configStore.set(configPath(), structuredClone(nextConfig));
    return { nextConfig };
  },
  resolveGatewayPort: (config: OpenClawConfig) => config.gateway?.port ?? 18789,
}));

vi.mock("./onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/tmp/openclaw-workspace",
  applyWizardMetadata: (config: OpenClawConfig) => config,
  ensureWorkspaceAndSessions,
}));

vi.mock("../plugins/migration-provider-runtime.js", () => ({
  ensureStandaloneMigrationProviderRegistryLoaded: vi.fn(),
  resolvePluginMigrationProviders: () => [provider],
  resolvePluginMigrationProvider: ({ providerId }: { providerId: string }) =>
    providerId === provider.id ? provider : undefined,
}));

import { runNonInteractiveSetup } from "./onboard-non-interactive.js";

function runtime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  };
}

describe("non-interactive migration onboarding", () => {
  beforeEach(() => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    configStore.clear();
    ensureWorkspaceAndSessions.mockClear();
    provider.plan.mockReset();
    provider.apply.mockReset();
  });

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it("stages, promotes, and acknowledges an explicit import", async () => {
    const stateDir = tempRoots.make("openclaw-noninteractive-migration-");
    const source = path.join(stateDir, "hermes-home");
    const workspace = path.join(stateDir, "workspace");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "AGENTS.md"), "Imported agents.\n", "utf8");
    process.env.OPENCLAW_STATE_DIR = stateDir;

    provider.plan.mockImplementation(async (ctx): Promise<MigrationPlan> => {
      const configuredWorkspace = ctx.config.agents?.defaults?.workspace;
      expect(configuredWorkspace).toBe(workspace);
      if (!configuredWorkspace) {
        throw new Error("missing configured workspace");
      }
      const target = path.join(configuredWorkspace, "AGENTS.md");
      const items: MigrationPlan["items"] = [
        {
          id: "workspace:AGENTS.md",
          kind: "workspace",
          action: "copy",
          status: "planned",
          source: path.join(source, "AGENTS.md"),
          target,
        },
      ];
      return {
        providerId: "hermes",
        source,
        target: path.dirname(target),
        items,
        summary: summarizeMigrationItems(items),
      };
    });
    provider.apply.mockImplementation(async (ctx, plan): Promise<MigrationApplyResult> => {
      const item = plan?.items[0];
      if (!plan || !item?.source || !item.target) {
        throw new Error("missing migration plan item");
      }
      await fs.mkdir(path.dirname(item.target), { recursive: true });
      await fs.copyFile(item.source, item.target);
      const items = [{ ...item, status: "migrated" as const }];
      return {
        ...plan,
        items,
        summary: summarizeMigrationItems(items),
        reportDir: ctx.reportDir,
      };
    });

    await runNonInteractiveSetup(
      {
        nonInteractive: true,
        mode: "local",
        workspace,
        authChoice: "skip",
        skipHealth: true,
        importFrom: "hermes",
        importSource: source,
      },
      runtime(),
    );

    expect(provider.plan).toHaveBeenCalledOnce();
    expect(provider.plan).toHaveBeenCalledWith(
      expect.objectContaining({ source, includeSecrets: false, overwrite: false }),
    );
    expect(provider.apply).toHaveBeenCalledOnce();
    const [applyContext, stagedPlan] = provider.apply.mock.calls[0] ?? [];
    expect(applyContext?.source).toBe(source);
    expect(applyContext?.reportDir).toContain(".openclaw-migration-state-");
    expect(stagedPlan?.items[0]?.target).toContain(".openclaw-migration-workspace-");
    expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe("Imported agents.\n");
    expect(configStore.get(configPath())?.agents?.defaults?.workspace).toBe(workspace);
    const [reportDir] = await fs.readdir(path.join(stateDir, "migration", "hermes"));
    await expect(
      fs.access(
        path.join(stateDir, "migration", "hermes", reportDir!, "onboarding-promotion.json"),
      ),
    ).rejects.toThrow();
    expect(ensureWorkspaceAndSessions).not.toHaveBeenCalled();
  });
});
