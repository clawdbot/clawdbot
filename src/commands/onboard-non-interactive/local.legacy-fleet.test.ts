// Real-reader setup reruns retain the selected fleet owner across mutation and reopen.
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertAuthProfile } from "../../agents/auth-profiles/profiles.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../../agents/auth-profiles/store.js";
import { readConfigFileSnapshot, resetConfigRuntimeState } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  applyOnboardingPrimaryModel,
  type OnboardingAgentTarget,
} from "../onboard-agent-target.js";

const mocks = vi.hoisted(() => ({
  applyAuthChoice: vi.fn(),
  ensureOnboardingAgent: vi.fn(),
  ensureWorkspaceAndSessions: vi.fn(),
}));

vi.mock("../onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../onboard-helpers.js")>()),
  ensureWorkspaceAndSessions: mocks.ensureWorkspaceAndSessions,
}));
vi.mock("../onboard-agent.js", () => ({ ensureOnboardingAgent: mocks.ensureOnboardingAgent }));
vi.mock("./local/auth-choice.js", () => ({
  applyNonInteractiveAuthChoice: mocks.applyAuthChoice,
}));

import { runNonInteractiveSetup } from "../onboard-non-interactive.js";

afterEach(() => {
  vi.resetAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  resetConfigRuntimeState();
});

describe("local setup fleet owner persistence", () => {
  it.each([
    { legacy: true, include: false },
    { legacy: true, include: true },
    { legacy: false, include: false },
    { legacy: false, include: true },
  ])("preserves a fleet through two real setup writes: %j", async ({ legacy, include }) => {
    const { ensureOnboardingAgent } =
      await vi.importActual<typeof import("../onboard-agent.js")>("../onboard-agent.js");
    mocks.ensureOnboardingAgent.mockImplementation(ensureOnboardingAgent);
    await withTempHome(async (rawHome) => {
      const home = await fs.realpath(rawHome);
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      const includePath = path.join(stateDir, "roster.json");
      const workspace = path.join(home, "existing-workspace");
      const siblingWorkspace = path.join(home, "alpha-workspace");
      const agentDir = path.join(stateDir, "agents", "beta", "agent");
      const entries = {
        alpha: { model: "fixture/alpha", workspace: siblingWorkspace },
        beta: { model: "fixture/beta", ...(!legacy ? { workspace } : {}), agentDir },
      };
      // The legacy default is deliberately neither the first nor lexical agent.
      const list = [
        { id: "alpha", ...entries.alpha },
        { id: "beta", default: true, ...entries.beta },
      ];
      const roster = legacy ? { list } : { entries };
      const includeRaw = JSON.stringify(roster);
      if (include) {
        await fs.writeFile(includePath, includeRaw);
      }
      const bindings = [
        { type: "route", agentId: "alpha", match: { channel: "discord", accountId: "*" } },
      ];
      const raw = JSON.stringify({
        agents: {
          ...(include ? { $include: "./roster.json" } : roster),
          ...(!legacy ? { ownership: "explicit" } : {}),
          defaults: {
            workspace,
            model: "fixture/shared",
            ...(!legacy ? { systemAgent: { agentId: "beta" } } : {}),
          },
        },
        bindings,
        gateway: { mode: "local", port: 24680 },
      });
      await fs.writeFile(configPath, raw);
      resetConfigRuntimeState();
      const before = await readConfigFileSnapshot();
      expect(before.valid, JSON.stringify(before.issues)).toBe(true);
      expect(before.sourceConfigBeforeMigrations?.agents).toMatchObject(roster);
      expect(before.sourceConfig.agents?.entries).toEqual(entries);
      expect(before.sourceConfig.agents?.list).toBeUndefined();
      expect(await fs.readFile(configPath, "utf8")).toBe(raw);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv;
      const profileId = "fixture:setup";
      mocks.applyAuthChoice.mockImplementation(
        async ({
          nextConfig,
          target,
        }: {
          nextConfig: OpenClawConfig;
          target: OnboardingAgentTarget;
        }) => {
          expect(target).toEqual({ agentId: "beta", agentDir, workspaceDir: workspace });
          upsertAuthProfile({
            agentDir: target.agentDir,
            profileId,
            credential: { type: "api_key", provider: "fixture", key: "synthetic-setup-key" },
          });
          // Include-owned entries remain authored in their own file. Root-owned
          // model edits exercise the writer's existing ownership projection.
          return include
            ? { ...nextConfig }
            : applyOnboardingPrimaryModel(nextConfig, target, "fixture/selected");
        },
      );

      for (let rerun = 0; rerun < 2; rerun += 1) {
        await runNonInteractiveSetup(
          {
            nonInteractive: true,
            mode: "local",
            agentName: "ignored",
            workspace: path.join(home, "requested-workspace"),
            authChoice: "fixture-api-key",
            skipBootstrap: true,
            skipSkills: true,
            skipHealth: true,
            installDaemon: false,
          },
          runtime,
        );
        await expect(mocks.ensureOnboardingAgent.mock.results[rerun]?.value).resolves.toMatchObject(
          {
            agentId: "beta",
            createdAgent: false,
          },
        );
        expect(mocks.ensureWorkspaceAndSessions).toHaveBeenLastCalledWith(
          workspace,
          runtime,
          expect.objectContaining({ agentId: "beta", skipBootstrap: true }),
        );
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        resetConfigRuntimeState();
        const reopened = await readConfigFileSnapshot();
        expect(reopened.valid, JSON.stringify(reopened.issues)).toBe(true);
        const expectedEntries = include
          ? entries
          : {
              ...entries,
              beta: {
                ...entries.beta,
                workspace,
                model: { primary: "fixture/selected" },
                models: { "fixture/selected": {} },
              },
            };
        expect(reopened.sourceConfig.agents?.entries).toEqual(expectedEntries);
        expect(reopened.sourceConfig.agents?.defaults).toMatchObject({
          workspace,
          model: "fixture/shared",
          skipBootstrap: true,
          systemAgent: { agentId: "beta" },
        });
        expect(reopened.sourceConfig.bindings).toEqual(bindings);
        expect(reopened.sourceConfig.gateway?.port).toBe(24680);
        expect(reopened.sourceConfig.hooks?.internal?.entries?.["session-memory"]?.enabled).toBe(
          true,
        );
        if (include) {
          expect(await fs.readFile(includePath, "utf8")).toBe(includeRaw);
          expect(JSON.parse(await fs.readFile(configPath, "utf8")).agents.$include).toBe(
            "./roster.json",
          );
        } else {
          const persisted = JSON.parse(await fs.readFile(configPath, "utf8"));
          expect(persisted.agents.entries).toEqual(expectedEntries);
          expect(persisted.agents.list).toBeUndefined();
          expect(persisted.agents.ownership).toBe("explicit");
          expect(persisted.agents.defaults.systemAgent).toEqual({ agentId: "beta" });
        }
        expect(
          loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
        ).toMatchObject({ provider: "fixture" });
        for (const nonOwner of ["alpha", "ignored"]) {
          expect(
            loadAuthProfileStoreWithoutExternalProfiles(
              path.join(stateDir, "agents", nonOwner, "agent"),
            ).profiles[profileId],
            `credentials must not be stored for ${nonOwner}`,
          ).toBeUndefined();
        }
      }
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("existing agents keep their current workspace"),
      );
    });
  });
});
