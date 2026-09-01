import { afterEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveSharedAuthStorePath } from "../agents/auth-profiles/path-resolve.js";
import {
  resolveAuthProfileDatabasePath,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import {
  loadAuthProfileStoreForRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
  resolvePersistedAuthProfileOwnerAgentDir,
} from "../agents/auth-profiles/store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeConfigMachineState } from "../state/config-machine-state.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { collectAuthProfileHealthFindings, noteAuthProfileHealth } from "./doctor-auth.js";
import { createDoctorPrompter } from "./doctor-prompter.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
const cliCredentials = vi.hoisted(() => ({ readCodex: vi.fn() }));
const refreshProfile = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../agents/auth-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/auth-profiles.js")>()),
  resolveApiKeyForProfile: refreshProfile,
}));
vi.mock("../agents/cli-credentials.js", () => ({
  readCodexCliCredentialsCached: cliCredentials.readCodex,
  readMiniMaxCliCredentialsCached: () => null,
}));

afterEach(() => {
  vi.clearAllMocks();
  cliCredentials.readCodex.mockReset();
});

describe("Doctor shared auth health", () => {
  it("reports shared OAuth expiry for an explicit fleet without local profiles", async () => {
    await withOpenClawTestState({ prefix: "openclaw-doctor-shared-health-" }, async (state) => {
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
        plugins: { enabled: false },
      };
      await state.writeConfig(cfg);
      const profileId = "diagnostic-provider:shared";
      const store = {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth" as const,
            provider: "diagnostic-provider",
            access: "synthetic-access",
            refresh: "synthetic-refresh",
            expires: Date.now() - 60_000,
          },
        },
      };
      writeConfigMachineState("auth.sharedStore", { location: "state-db" });
      writePersistedAuthProfileStoreRaw(store);
      const sharedPath = resolveSharedAuthStorePath();
      const prompter = createDoctorPrompter({
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        options: { nonInteractive: true },
      });

      const findings = await collectAuthProfileHealthFindings({ cfg });
      await noteAuthProfileHealth({ cfg, prompter, allowKeychainPrompt: false });

      expect.soft(findings).toEqual([
        expect.objectContaining({
          target: profileId,
          path: sharedPath,
          message: expect.stringContaining("expired"),
        }),
      ]);
      expect
        .soft(vi.mocked(note).mock.calls)
        .toEqual([[expect.stringContaining(`${profileId}: expired`), "Model auth"]]);
      expect(loadAuthProfileStoreWithoutExternalProfiles().profiles).toEqual(store.profiles);
    });
  });

  it("keeps inherited-profile recovery guidance local without duplicating shared expiry", async () => {
    await withOpenClawTestState({ prefix: "openclaw-doctor-auth-owners-" }, async (state) => {
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
        plugins: { enabled: false },
      };
      await state.writeConfig(cfg);
      const profileId = "diagnostic-provider:shared";
      writeConfigMachineState("auth.sharedStore", { location: "state-db" });
      writePersistedAuthProfileStoreRaw({
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "diagnostic-provider",
            access: "synthetic-access",
            refresh: "synthetic-refresh",
            expires: Date.now() - 60_000,
          },
        },
      });
      const agentDir = state.agentDir("alpha");
      writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, agentDir);
      writePersistedAuthProfileStateRaw(
        {
          version: 1,
          usageStats: {
            [profileId]: { cooldownUntil: Date.now() + 600_000, cooldownReason: "session_expired" },
          },
        },
        agentDir,
      );

      const findings = await collectAuthProfileHealthFindings({ cfg });
      expect.soft(findings).toEqual([
        expect.objectContaining({
          target: profileId,
          path: resolveSharedAuthStorePath(),
          message: expect.stringContaining("expired"),
        }),
        expect.objectContaining({
          target: profileId,
          path: resolveAuthProfileDatabasePath(agentDir),
          message: expect.stringContaining("cooldown:session_expired"),
          fixHint:
            "Re-authenticate with `openclaw models auth login --provider diagnostic-provider --profile-id 'diagnostic-provider:shared'`.",
        }),
      ]);
      await noteAuthProfileHealth({
        cfg,
        prompter: createDoctorPrompter({
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          options: { nonInteractive: true },
        }),
        allowKeychainPrompt: false,
      });
      expect(vi.mocked(note)).toHaveBeenCalledWith(
        expect.stringContaining(
          "Re-authenticate with `openclaw models auth login --provider diagnostic-provider --profile-id 'diagnostic-provider:shared'`.",
        ),
        "Auth profile cooldowns (Agent alpha)",
      );
    });
  });

  it("preserves external CLI overlays when checking an agent-local auth store", async () => {
    await withOpenClawTestState({ prefix: "openclaw-doctor-cli-auth-" }, async (state) => {
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
        plugins: { enabled: false },
      };
      await state.writeConfig(cfg);
      writeConfigMachineState("auth.sharedStore", { location: "state-db" });
      writePersistedAuthProfileStoreRaw(
        {
          version: 1,
          profiles: { "openai:default": { type: "oauth", provider: "openai", expires: 1 } },
        },
        state.agentDir("alpha"),
      );
      cliCredentials.readCodex.mockReturnValue({
        type: "oauth",
        provider: "openai",
        access: "synthetic-cli-access",
        refresh: "synthetic-cli-refresh",
        expires: Date.now() + 7 * 86_400_000,
      });

      expect(await collectAuthProfileHealthFindings({ cfg })).toEqual([]);
      expect(cliCredentials.readCodex).toHaveBeenCalledWith(
        expect.objectContaining({ allowKeychainPrompt: false }),
      );
    });
  });

  it.each([
    { name: "healthy shared", sharedExpired: false, sameAccount: true, owner: undefined },
    { name: "expired shared", sharedExpired: true, sameAccount: true, owner: "shared" },
    { name: "distinct local account", sharedExpired: false, sameAccount: false, owner: "local" },
  ])("respects canonical OAuth ownership for $name credentials", async (scenario) => {
    await withOpenClawTestState({ prefix: "openclaw-doctor-oauth-owner-" }, async (state) => {
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
        plugins: { enabled: false },
      };
      await state.writeConfig(cfg);
      writeConfigMachineState("auth.sharedStore", { location: "state-db" });
      const profileId = "diagnostic-provider:shared";
      const shared = {
        type: "oauth" as const,
        provider: "diagnostic-provider",
        access: "synthetic-shared-access",
        refresh: "synthetic-shared-refresh",
        accountId: "shared-account",
        expires: Date.now() + (scenario.sharedExpired ? -60_000 : 7 * 86_400_000),
      };
      const local = {
        ...shared,
        access: "synthetic-old-local-access",
        refresh: "synthetic-old-local-refresh",
        accountId: scenario.sameAccount ? shared.accountId : "local-account",
        expires: Date.now() - 120_000,
      };
      const agentDir = state.agentDir("alpha");
      writePersistedAuthProfileStoreRaw({ version: 1, profiles: { [profileId]: shared } });
      writePersistedAuthProfileStoreRaw({ version: 1, profiles: { [profileId]: local } }, agentDir);

      expect(loadAuthProfileStoreForRuntime(agentDir).profiles[profileId]).toEqual(local);
      expect(resolvePersistedAuthProfileOwnerAgentDir({ agentDir, profileId })).toBe(
        scenario.sameAccount ? undefined : agentDir,
      );
      const findings = await collectAuthProfileHealthFindings({ cfg });
      expect.soft(findings).toEqual(
        scenario.owner
          ? [
              expect.objectContaining({
                target: profileId,
                path:
                  scenario.owner === "shared"
                    ? resolveSharedAuthStorePath()
                    : resolveAuthProfileDatabasePath(agentDir),
                message: expect.stringContaining("expired"),
              }),
            ]
          : [],
      );
      const prompter = createDoctorPrompter({
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        options: { nonInteractive: true, repair: true },
      });
      await noteAuthProfileHealth({ cfg, prompter, allowKeychainPrompt: false });
      expect(refreshProfile).toHaveBeenCalledTimes(scenario.owner ? 1 : 0);
      if (scenario.owner) {
        expect(refreshProfile).toHaveBeenCalledWith(
          expect.objectContaining({
            profileId,
            agentDir: scenario.owner === "shared" ? undefined : agentDir,
            forceRefresh: true,
          }),
        );
      }
    });
  });
});
