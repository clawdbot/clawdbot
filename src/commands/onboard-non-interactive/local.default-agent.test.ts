// Non-interactive setup tests keep provisioning and output on the configured default agent.
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot, resetConfigRuntimeState } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { OnboardOptions } from "../onboard-types.js";

const mocks = vi.hoisted(() => ({
  applyAuthChoice: vi.fn(),
  applyGatewayConfig: vi.fn(),
  commitConfig: vi.fn(),
  ensureOnboardingAgent: vi.fn(),
  ensureWorkspaceAndSessions: vi.fn(),
  inferAuthChoice: vi.fn(),
  logConfigUpdated: vi.fn(),
  logJson: vi.fn(),
}));

vi.mock("../../config/logging.js", () => ({
  logConfigUpdated: mocks.logConfigUpdated,
}));

vi.mock("../onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/tmp/default-workspace",
  applyWizardMetadata: (config: OpenClawConfig) => config,
  ensureWorkspaceAndSessions: mocks.ensureWorkspaceAndSessions,
  resolveLocalControlUiProbeLinks: vi.fn(),
  waitForGatewayReachable: vi.fn(),
}));

vi.mock("./config-write.js", () => ({
  commitNonInteractiveOnboardConfig: mocks.commitConfig,
}));

vi.mock("../onboard-agent.js", () => ({
  ensureOnboardingAgent: mocks.ensureOnboardingAgent,
}));

vi.mock("./local/auth-choice.js", () => ({
  applyNonInteractiveAuthChoice: mocks.applyAuthChoice,
}));

vi.mock("./local/auth-choice-inference.js", () => ({
  inferAuthChoiceFromFlags: mocks.inferAuthChoice,
}));

vi.mock("./local/gateway-config.js", () => ({
  applyNonInteractiveGatewayConfig: mocks.applyGatewayConfig,
}));

vi.mock("./local/output.js", () => ({
  logNonInteractiveOnboardingFailure: vi.fn(),
  logNonInteractiveOnboardingJson: mocks.logJson,
}));

vi.mock("./local/skills-config.js", () => ({
  applyNonInteractiveSkillsConfig: ({ nextConfig }: { nextConfig: OpenClawConfig }) => nextConfig,
}));

import { runNonInteractiveSetup } from "../onboard-non-interactive.js";
import { runNonInteractiveLocalSetup } from "./local.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  resetConfigRuntimeState();
});

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
} as unknown as RuntimeEnv;

const localOptions = {
  nonInteractive: true,
  mode: "local",
  skipHooks: true,
  skipSkills: true,
  skipHealth: true,
} satisfies OnboardOptions;

describe("runNonInteractiveLocalSetup default-agent ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.applyAuthChoice.mockImplementation(
      async ({ nextConfig }: { nextConfig: OpenClawConfig }) => nextConfig,
    );
    mocks.applyGatewayConfig.mockImplementation(
      ({ nextConfig }: { nextConfig: OpenClawConfig }) => ({
        nextConfig,
        port: 18789,
        bind: "loopback",
        authMode: "token",
        tailscaleMode: "off",
      }),
    );
    mocks.commitConfig.mockImplementation(
      async ({ nextConfig }: { nextConfig: OpenClawConfig }) => nextConfig,
    );
    mocks.ensureOnboardingAgent.mockImplementation(
      async ({ config }: { config: OpenClawConfig }) => ({
        config,
        agentId: "ops",
        bootstrapPending: false,
      }),
    );
    mocks.inferAuthChoice.mockReturnValue({ matches: [] });
  });

  it.each([false, true])(
    "rejects ambiguous provider flags before creating an agent or writing setup state (json: %s)",
    async (json) => {
      mocks.inferAuthChoice.mockReturnValue({
        matches: [
          { optionKey: "openaiApiKey", authChoice: "openai-api-key", label: "--openai-api-key" },
          {
            optionKey: "anthropicApiKey",
            authChoice: "anthropic-api-key",
            label: "--anthropic-api-key",
          },
        ],
      });

      await runNonInteractiveLocalSetup({
        opts: {
          ...localOptions,
          openaiApiKey: "openai-test-key",
          anthropicApiKey: "anthropic-test-key",
          json,
        },
        runtime,
        baseConfig: {},
        sourceConfigBeforeMigrations: {},
      });

      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("Multiple API key flags were provided"),
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
      if (json) {
        expect(runtime.log).toHaveBeenCalledWith(
          JSON.stringify(
            {
              ok: false,
              phase: "options",
              message: [
                "Multiple API key flags were provided for non-interactive setup.",
                "Use a single provider flag or pass --auth-choice explicitly.",
                "Flags: --openai-api-key, --anthropic-api-key",
              ].join("\n"),
            },
            null,
            2,
          ),
        );
      } else {
        expect(runtime.log).not.toHaveBeenCalled();
      }
      expect(mocks.applyGatewayConfig).not.toHaveBeenCalled();
      expect(mocks.applyAuthChoice).not.toHaveBeenCalled();
      expect(mocks.ensureOnboardingAgent).not.toHaveBeenCalled();
      expect(mocks.commitConfig).not.toHaveBeenCalled();
      expect(mocks.ensureWorkspaceAndSessions).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: "fresh unnamed", agents: undefined, legacyState: false, agentName: undefined },
    { label: "fresh named", agents: undefined, legacyState: false, agentName: "robby" },
    { label: "rosterless", agents: {}, legacyState: false, agentName: "robby" },
    {
      label: "empty keyed roster",
      agents: { entries: {} },
      legacyState: false,
      agentName: "robby",
    },
    { label: "empty legacy roster", agents: { list: [] }, legacyState: false, agentName: "robby" },
    { label: "legacy workspace state", agents: {}, legacyState: true, agentName: "robby" },
  ])(
    "keeps auth and provisioning on the requested owner with $label config",
    async ({ agents, legacyState, agentName }) => {
      const agentId = agentName ?? "main";
      await withTempHome(async (rawHome) => {
        const home = await fs.realpath(rawHome);
        const workspace = path.join(home, "requested-workspace");
        const oldWorkspace = path.join(home, "old-workspace");
        const expectedWorkspace = legacyState ? oldWorkspace : workspace;
        if (!legacyState) {
          // withTempHome seeds main sessions; this branch models no existing installation.
          await fs.rm(path.join(home, ".openclaw", "agents"), { recursive: true });
        }
        if (agents) {
          const configDir = path.join(home, ".openclaw");
          await fs.mkdir(configDir, { recursive: true });
          await fs.writeFile(
            path.join(configDir, "openclaw.json"),
            JSON.stringify({
              agents: { ...agents, defaults: { workspace: oldWorkspace } },
            }),
          );
        }
        resetConfigRuntimeState();
        const snapshot = await readConfigFileSnapshot();
        expect(snapshot.valid).toBe(true);
        expect(snapshot.exists).toBe(agents !== undefined);
        if (agents) {
          expect(snapshot.sourceConfigBeforeMigrations?.agents).toEqual({
            ...agents,
            defaults: { workspace: oldWorkspace },
          });
          expect(snapshot.sourceConfig?.agents?.entries).toEqual({ main: {} });
        }
        mocks.ensureOnboardingAgent.mockImplementationOnce(
          async ({ config }: { config: OpenClawConfig }) => ({
            config: {
              ...config,
              agents: {
                ...config.agents,
                entries: {
                  [agentId]: {
                    ...(agentName ? { name: agentName } : { default: true }),
                    workspace: expectedWorkspace,
                  },
                },
              },
            },
            agentId,
            bootstrapPending: true,
            createdAgent: true,
          }),
        );

        await runNonInteractiveSetup(
          {
            ...localOptions,
            ...(agentName ? { agentName, json: true } : {}),
            workspace,
            authChoice: "demo-api-key",
          },
          runtime,
        );

        expect(mocks.applyAuthChoice).toHaveBeenCalledWith(
          expect.objectContaining({
            target: {
              agentId,
              agentDir: path.join(home, ".openclaw", "agents", agentId, "agent"),
              workspaceDir: expectedWorkspace,
            },
            nextConfig: expect.objectContaining({
              agents: expect.objectContaining({
                defaults: expect.objectContaining({ workspace: expectedWorkspace }),
              }),
            }),
          }),
        );
        expect(mocks.applyAuthChoice.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.ensureOnboardingAgent.mock.invocationCallOrder[0]!,
        );
        expect(mocks.ensureOnboardingAgent).toHaveBeenCalledOnce();
        expect(mocks.ensureOnboardingAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            firstAgent: { name: agentId },
            workspace: expectedWorkspace,
          }),
        );
        expect(mocks.ensureWorkspaceAndSessions).toHaveBeenCalledWith(
          expectedWorkspace,
          runtime,
          expect.objectContaining({ agentId }),
        );
        expect(mocks.commitConfig.mock.invocationCallOrder[0]).toBeGreaterThan(
          mocks.ensureOnboardingAgent.mock.invocationCallOrder[0]!,
        );
        expect(mocks.ensureWorkspaceAndSessions.mock.calls.map(([dir]) => dir)).not.toContain(
          `${workspace}/main`,
        );
        expect(mocks.logJson).toHaveBeenCalledWith(
          expect.objectContaining({ workspaceDir: expectedWorkspace }),
        );
        if (legacyState) {
          expect(runtime.error).toHaveBeenCalledWith(
            expect.stringContaining("existing agents keep their current workspace"),
          );
        } else {
          expect(runtime.error).not.toHaveBeenCalled();
        }
      });
    },
  );

  it.each(
    [false, true].flatMap((existing) =>
      (["none", "during-auth", "after-creation"] as const).map((foreignWrite) => ({
        existing,
        foreignWrite,
      })),
    ),
  )(
    "guards the config revision across named creation: existing=$existing, foreign=$foreignWrite",
    async ({ existing, foreignWrite }) => {
      const { ensureOnboardingAgent } =
        await vi.importActual<typeof import("../onboard-agent.js")>("../onboard-agent.js");
      const { commitNonInteractiveOnboardConfig } =
        await vi.importActual<typeof import("./config-write.js")>("./config-write.js");
      await withTempHome(async (rawHome) => {
        const home = await fs.realpath(rawHome);
        const configDir = path.join(home, ".openclaw");
        const configPath = path.join(configDir, "openclaw.json");
        const workspace = path.join(home, "workspace");
        // Remove the helper's legacy main sessions to exercise first-install admission.
        await fs.rm(path.join(configDir, "agents"), { recursive: true });
        const initialConfig = {
          agents: { defaults: { model: { primary: "fixture/baseline" } } },
        };
        const initialRaw = existing ? JSON.stringify(initialConfig) : null;
        if (initialRaw) {
          await fs.writeFile(configPath, initialRaw);
        }
        resetConfigRuntimeState();
        const before = await readConfigFileSnapshot();
        expect(before.valid).toBe(true);
        expect(before.exists).toBe(existing);
        expect(before.sourceConfigBeforeMigrations ?? {}).toEqual(existing ? initialConfig : {});
        if (existing) {
          expect(before.sourceConfig?.agents?.entries).toEqual({ main: {} });
        }
        let foreignRaw: string | undefined;
        const writeForeignConfig = async (config: OpenClawConfig) => {
          foreignRaw = JSON.stringify({
            ...config,
            agents: {
              ...config.agents,
              defaults: { ...config.agents?.defaults, model: { primary: "fixture/foreign" } },
            },
          });
          await fs.writeFile(configPath, foreignRaw);
        };
        mocks.applyAuthChoice.mockImplementationOnce(async ({ nextConfig }) => {
          const currentRaw = existing ? await fs.readFile(configPath, "utf8") : null;
          expect(currentRaw).toBe(initialRaw);
          if (!existing) {
            await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
          }
          if (foreignWrite === "during-auth") {
            await writeForeignConfig(existing ? initialConfig : {});
          }
          return {
            ...nextConfig,
            agents: {
              ...nextConfig.agents,
              defaults: {
                ...nextConfig.agents?.defaults,
                model: { primary: "fixture/selected" },
              },
            },
          };
        });
        let creationHash: string | undefined;
        mocks.ensureOnboardingAgent.mockImplementationOnce(async (params) => {
          const created = await ensureOnboardingAgent(params);
          creationHash = created.configHash;
          if (foreignWrite === "after-creation") {
            await writeForeignConfig(JSON.parse(await fs.readFile(configPath, "utf8")));
          }
          return created;
        });
        mocks.commitConfig.mockImplementationOnce(commitNonInteractiveOnboardConfig);

        const outcome = await runNonInteractiveSetup(
          {
            ...localOptions,
            agentName: "robby",
            workspace,
            authChoice: "demo-api-key",
            skipBootstrap: true,
            installDaemon: false,
            json: true,
          },
          runtime,
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        const persistedRaw = await fs.readFile(configPath, "utf8");
        if (foreignWrite !== "none") {
          expect.soft(persistedRaw).toBe(foreignRaw);
          expect(outcome).toBeInstanceOf(Error);
          expect((outcome as Error).message).toMatch(/config changed|base hash/i);
          expect(mocks.commitConfig).toHaveBeenCalledTimes(foreignWrite === "during-auth" ? 0 : 1);
          expect(mocks.logConfigUpdated).not.toHaveBeenCalled();
        } else {
          expect(outcome).toBeUndefined();
          expect(creationHash).toEqual(expect.any(String));
          expect(creationHash).not.toBe(before.hash);
          expect(mocks.commitConfig).toHaveBeenCalledWith(
            expect.objectContaining({ baseHash: creationHash }),
          );
          expect(JSON.parse(persistedRaw).agents).toMatchObject({
            defaults: { workspace, model: { primary: "fixture/selected" } },
            entries: { robby: { name: "robby", workspace } },
          });
          expect(Object.keys(JSON.parse(persistedRaw).agents.entries)).toEqual(["robby"]);
          expect(mocks.logConfigUpdated).toHaveBeenCalledOnce();
        }
      });
    },
  );

  it("rejects invalid gateway options before provider auth or first-agent creation", async () => {
    mocks.applyGatewayConfig.mockReturnValue(null);

    await runNonInteractiveLocalSetup({
      opts: {
        ...localOptions,
        authChoice: "demo-api-key",
        gatewayPort: 70_000,
      },
      runtime,
      baseConfig: {},
      sourceConfigBeforeMigrations: {},
    });

    expect(mocks.applyGatewayConfig).toHaveBeenCalledOnce();
    expect(mocks.applyAuthChoice).not.toHaveBeenCalled();
    expect(mocks.ensureOnboardingAgent).not.toHaveBeenCalled();
    expect(mocks.commitConfig).not.toHaveBeenCalled();
    expect(mocks.ensureWorkspaceAndSessions).not.toHaveBeenCalled();
  });

  it("does not publish config when the existing agent workspace cannot be provisioned", async () => {
    mocks.ensureWorkspaceAndSessions.mockRejectedValueOnce(new Error("workspace is unwritable"));

    await expect(
      runNonInteractiveLocalSetup({
        opts: {
          ...localOptions,
          authChoice: "skip",
        },
        runtime,
        baseConfig: { agents: { entries: { ops: { default: true } } } },
        sourceConfigBeforeMigrations: { agents: { entries: { ops: { default: true } } } },
      }),
    ).rejects.toThrow("workspace is unwritable");

    expect(mocks.commitConfig).not.toHaveBeenCalled();
    expect(mocks.logConfigUpdated).not.toHaveBeenCalled();
  });

  it.each([
    { agentId: "main", include: false, explicit: false },
    { agentId: "ops", include: false, explicit: false },
    { agentId: "main", include: true, explicit: false },
    { agentId: "ops", include: false, explicit: true },
  ])(
    "preserves the authored auth owner and workspace: %j",
    async ({ agentId, include, explicit }) => {
      await withTempHome(async (rawHome) => {
        const home = await fs.realpath(rawHome);
        const globalWorkspace = path.join(home, "global-workspace");
        const agentDir = path.join(home, ".openclaw", "agents", agentId, "agent");
        const workspaceDir =
          agentId === "main" ? globalWorkspace : path.join(home, "ops-workspace");
        const entries = {
          ...(explicit ? { main: {} } : {}),
          [agentId]: agentId === "main" ? {} : { agentDir, workspace: workspaceDir },
        };
        const configDir = path.join(home, ".openclaw");
        const roster = { agents: { entries } };
        if (include) {
          await fs.writeFile(path.join(configDir, "roster.json"), JSON.stringify(roster));
        }
        await fs.writeFile(
          path.join(configDir, "openclaw.json"),
          JSON.stringify({
            ...(include ? { $include: "./roster.json" } : {}),
            agents: {
              ...(!include ? { entries } : {}),
              ...(explicit ? { ownership: "explicit" } : {}),
              defaults: {
                workspace: globalWorkspace,
                ...(explicit ? { systemAgent: { agentId } } : {}),
              },
            },
          }),
        );
        resetConfigRuntimeState();
        mocks.ensureOnboardingAgent.mockImplementationOnce(
          async ({ config }: { config: OpenClawConfig }) => ({
            config,
            agentId,
            bootstrapPending: false,
            createdAgent: false,
          }),
        );

        await runNonInteractiveSetup(
          {
            ...localOptions,
            agentName: "robby",
            workspace: globalWorkspace,
            authChoice: "demo-api-key",
            installDaemon: false,
            json: true,
          },
          runtime,
        );

        expect(mocks.applyAuthChoice).toHaveBeenCalledWith(
          expect.objectContaining({
            target: { agentId, agentDir, workspaceDir },
          }),
        );
        expect(mocks.commitConfig).toHaveBeenCalledWith(
          expect.objectContaining({
            nextConfig: expect.objectContaining({
              agents: expect.objectContaining({
                entries,
                defaults: expect.objectContaining({ workspace: globalWorkspace }),
              }),
            }),
          }),
        );
        expect(mocks.ensureWorkspaceAndSessions).toHaveBeenCalledWith(
          workspaceDir,
          runtime,
          expect.objectContaining({ agentId }),
        );
        expect(mocks.logJson).toHaveBeenCalledWith(expect.objectContaining({ workspaceDir }));
        if (include) {
          expect(
            JSON.parse(await fs.readFile(path.join(configDir, "roster.json"), "utf8")),
          ).toEqual(roster);
        }
      });
    },
  );
});
