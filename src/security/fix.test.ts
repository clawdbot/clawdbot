// Covers security fixer behavior for supported audit findings.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import { fixSecurityFootguns } from "./fix.js";

const isWindows = process.platform === "win32";

const expectPerms = (actual: number, expected: number) => {
  if (isWindows) {
    expect([expected, 0o666, 0o777]).toContain(actual);
    return;
  }
  expect(actual).toBe(expected);
};

describe("security fix", () => {
  let fixtureRoot = "";
  let fixtureCount = 0;

  const createStateDir = async (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  const createFixEnv = (stateDir: string, configPath: string) => ({
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
  });

  const runConfigFixScenario = async (params: {
    prefix: string;
    cfg: OpenClawConfig;
    channelPlugins?: ChannelPlugin[];
  }) => {
    const stateDir = await createStateDir(params.prefix);
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, `${JSON.stringify(params.cfg, null, 2)}\n`, "utf-8");
    const res = await fixSecurityFootguns({
      env: createFixEnv(stateDir, configPath),
      stateDir,
      configPath,
      channelPlugins: params.channelPlugins,
    });
    const cfg = JSON.parse(await fs.readFile(configPath, "utf-8")) as OpenClawConfig;
    return { res, cfg };
  };

  const createWhatsAppConfigFixTestPlugin = (storeAllowFrom: string[]): ChannelPlugin => ({
    id: "whatsapp",
    meta: {
      id: "whatsapp",
      label: "WhatsApp",
      selectionLabel: "WhatsApp",
      docsPath: "/docs/testing",
      blurb: "test stub",
    },
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    config: {
      listAccountIds: () => ["default"],
      inspectAccount: () => ({ accountId: "default", enabled: true, configured: true, config: {} }),
      resolveAccount: () => ({ accountId: "default", enabled: true, config: {} }),
      isEnabled: () => true,
      isConfigured: () => true,
    },
    security: {
      applyConfigFixes: async ({ cfg }) => {
        if (storeAllowFrom.length === 0) {
          return { config: cfg, changes: [] };
        }
        const next = structuredClone(cfg ?? {});
        const whatsapp = next.channels?.whatsapp as Record<string, unknown> | undefined;
        if (!whatsapp || typeof whatsapp !== "object") {
          return { config: cfg, changes: [] };
        }
        const changes: string[] = [];
        let changed = false;
        const maybeApply = (prefix: string, holder: Record<string, unknown>) => {
          if (holder.groupPolicy !== "allowlist") {
            return;
          }
          const allowFrom = Array.isArray(holder.allowFrom) ? holder.allowFrom : [];
          const groupAllowFrom = Array.isArray(holder.groupAllowFrom) ? holder.groupAllowFrom : [];
          if (allowFrom.length > 0 || groupAllowFrom.length > 0) {
            return;
          }
          holder.groupAllowFrom = [...storeAllowFrom];
          changes.push(`${prefix}groupAllowFrom=pairing-store`);
          changed = true;
        };

        maybeApply("channels.whatsapp.", whatsapp);
        const accounts = whatsapp.accounts;
        if (accounts && typeof accounts === "object") {
          for (const [accountId, value] of Object.entries(accounts)) {
            if (!value || typeof value !== "object") {
              continue;
            }
            maybeApply(
              `channels.whatsapp.accounts.${accountId}.`,
              value as Record<string, unknown>,
            );
          }
        }

        return { config: changed ? next : cfg, changes };
      },
    },
  });

  const expectTightenedStateAndConfigPerms = async (stateDir: string, configPath: string) => {
    const stateMode = (await fs.stat(stateDir)).mode & 0o777;
    expectPerms(stateMode, 0o700);

    const configMode = (await fs.stat(configPath)).mode & 0o777;
    expectPerms(configMode, 0o600);
  };

  const expectWhatsAppGroupPolicy = (
    channels: Record<string, Record<string, unknown>>,
    expectedPolicy = "allowlist",
  ) => {
    expect(expectDefined(channels.whatsapp, "channels.whatsapp test invariant").groupPolicy).toBe(
      expectedPolicy,
    );
  };

  const expectWhatsAppAccountGroupPolicy = (
    channels: Record<string, Record<string, unknown>>,
    accountId: string,
    expectedPolicy = "allowlist",
  ) => {
    const whatsapp = expectDefined(channels.whatsapp, "channels.whatsapp test invariant");
    const accounts = whatsapp.accounts as Record<string, Record<string, unknown>>;
    const account = accounts[accountId];
    if (!account) {
      throw new Error(`Expected WhatsApp account ${accountId}`);
    }
    expect(account.groupPolicy).toBe(expectedPolicy);
    return accounts;
  };

  const fixWhatsAppConfigScenario = async (params: {
    whatsapp: Record<string, unknown>;
    allowFromStore: string[];
  }) => {
    const fixed = await runConfigFixScenario({
      prefix: "whatsapp-config",
      cfg: {
        channels: {
          whatsapp: params.whatsapp,
        },
      } satisfies OpenClawConfig,
      channelPlugins: [createWhatsAppConfigFixTestPlugin(params.allowFromStore)],
    });
    return {
      res: fixed.res,
      channels: fixed.cfg.channels as Record<string, Record<string, unknown>>,
    };
  };

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-security-fix-suite-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("tightens groupPolicy + filesystem perms", async () => {
    const cfg = {
      channels: {
        telegram: { groupPolicy: "open" },
        whatsapp: { groupPolicy: "open" },
        discord: { groupPolicy: "open" },
        signal: { groupPolicy: "open" },
        imessage: { groupPolicy: "open" },
      },
    } satisfies OpenClawConfig;
    const fixed = await runConfigFixScenario({
      prefix: "group-policy",
      cfg,
      channelPlugins: [createWhatsAppConfigFixTestPlugin(["+15551234567"])],
    });
    expect(fixed.res.changes).toEqual([
      "channels.telegram.groupPolicy=open -> allowlist",
      "channels.whatsapp.groupPolicy=open -> allowlist",
      "channels.discord.groupPolicy=open -> allowlist",
      "channels.signal.groupPolicy=open -> allowlist",
      "channels.imessage.groupPolicy=open -> allowlist",
      "channels.whatsapp.groupAllowFrom=pairing-store",
    ]);

    const channels = fixed.cfg.channels as Record<string, Record<string, unknown>>;
    expect(expectDefined(channels.telegram, "channels.telegram test invariant").groupPolicy).toBe(
      "allowlist",
    );
    expect(expectDefined(channels.whatsapp, "channels.whatsapp test invariant").groupPolicy).toBe(
      "allowlist",
    );
    expect(expectDefined(channels.discord, "channels.discord test invariant").groupPolicy).toBe(
      "allowlist",
    );
    expect(expectDefined(channels.signal, "channels.signal test invariant").groupPolicy).toBe(
      "allowlist",
    );
    expect(expectDefined(channels.imessage, "channels.imessage test invariant").groupPolicy).toBe(
      "allowlist",
    );

    expect(
      expectDefined(channels.whatsapp, "channels.whatsapp test invariant").groupAllowFrom,
    ).toEqual(["+15551234567"]);
  });

  it("applies allowlist per-account and seeds WhatsApp groupAllowFrom from store", async () => {
    const { res, channels } = await fixWhatsAppConfigScenario({
      whatsapp: {
        accounts: {
          a1: { groupPolicy: "open" },
        },
      },
      allowFromStore: ["+15550001111"],
    });
    expect(res.ok).toBe(true);
    const accounts = expectWhatsAppAccountGroupPolicy(channels, "a1");
    expect(expectDefined(accounts.a1, "accounts.a1 test invariant").groupAllowFrom).toEqual([
      "+15550001111",
    ]);
  });

  it("does not seed WhatsApp groupAllowFrom if allowFrom is set", async () => {
    const { res, channels } = await fixWhatsAppConfigScenario({
      whatsapp: {
        groupPolicy: "open",
        allowFrom: ["+15552223333"],
      },
      allowFromStore: ["+15550001111"],
    });
    expect(res.ok).toBe(true);
    expectWhatsAppGroupPolicy(channels);
    expect(
      expectDefined(channels.whatsapp, "channels.whatsapp test invariant").groupAllowFrom,
    ).toBeUndefined();
  });

  it("returns ok=false for invalid config but still tightens perms", async () => {
    const stateDir = await createStateDir("invalid-config");
    await fs.chmod(stateDir, 0o755);

    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, "{ this is not json }\n", "utf-8");
    await fs.chmod(configPath, 0o644);

    const env = createFixEnv(stateDir, configPath);

    const res = await fixSecurityFootguns({ env, stateDir, configPath });
    expect(res.ok).toBe(false);

    await expectTightenedStateAndConfigPerms(stateDir, configPath);
  });

  it("collects permission targets for credentials + agent auth/sessions + include files", async () => {
    const stateDir = await createStateDir("includes");

    const includesDir = path.join(stateDir, "includes");
    await fs.mkdir(includesDir, { recursive: true });
    const includePath = path.join(includesDir, "extra.json5");
    await fs.writeFile(includePath, "{ logging: { redactSensitive: 'off' } }\n", "utf-8");
    await fs.chmod(includePath, 0o644);

    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(
      configPath,
      `{ "$include": "./includes/extra.json5", channels: { whatsapp: { groupPolicy: "open" } } }\n`,
      "utf-8",
    );
    await fs.chmod(configPath, 0o644);

    const credsDir = path.join(stateDir, "credentials");
    await fs.mkdir(credsDir, { recursive: true });
    const allowFromPath = path.join(credsDir, "whatsapp-allowFrom.json");
    await fs.writeFile(
      allowFromPath,
      `${JSON.stringify({ version: 1, allowFrom: ["+15550002222"] }, null, 2)}\n`,
      "utf-8",
    );
    await fs.chmod(allowFromPath, 0o644);

    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    const authDatabasePath = path.join(agentDir, "openclaw-agent.sqlite");
    await fs.writeFile(authDatabasePath, "sqlite\n", "utf-8");
    await fs.writeFile(`${authDatabasePath}-wal`, "wal\n", "utf-8");
    await fs.writeFile(`${authDatabasePath}-shm`, "shm\n", "utf-8");
    await fs.writeFile(`${authDatabasePath}-journal`, "journal\n", "utf-8");
    const authProfilesPath = path.join(agentDir, "auth-profiles.json");
    await fs.writeFile(authProfilesPath, "{}\n", "utf-8");
    await fs.chmod(authProfilesPath, 0o644);

    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionsStorePath = path.join(sessionsDir, "sessions.json");
    await fs.writeFile(sessionsStorePath, "{}\n", "utf-8");
    await fs.chmod(sessionsStorePath, 0o644);
    const transcriptPath = path.join(sessionsDir, "sess-main.jsonl");
    await fs.writeFile(transcriptPath, '{"type":"session"}\n', "utf-8");
    await fs.chmod(transcriptPath, 0o644);

    const result = await fixSecurityFootguns({
      env: createFixEnv(stateDir, configPath),
      stateDir,
      configPath,
      channelPlugins: [],
    });
    const canonicalIncludePath = await fs.realpath(includePath);

    expect(result.actions.map((action) => action.path)).toEqual([
      stateDir,
      configPath,
      canonicalIncludePath,
      credsDir,
      allowFromPath,
      path.join(stateDir, "agents", "main"),
      agentDir,
      authDatabasePath,
      `${authDatabasePath}-wal`,
      `${authDatabasePath}-shm`,
      `${authDatabasePath}-journal`,
      authProfilesPath,
      sessionsDir,
      sessionsStorePath,
      transcriptPath,
    ]);
  });

  it("tightens the live legacy main auth store for a named default roster", async () => {
    const stateDir = await createStateDir("named-default-legacy-auth");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({ agents: { entries: { ops: { default: true } } } }),
      "utf-8",
    );
    const legacyAuthPath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
    await fs.mkdir(path.dirname(legacyAuthPath), { recursive: true });
    await fs.writeFile(legacyAuthPath, "{}\n", "utf-8");
    await fs.chmod(legacyAuthPath, 0o644);

    const result = await fixSecurityFootguns({
      env: createFixEnv(stateDir, configPath),
      stateDir,
      configPath,
      channelPlugins: [],
    });

    expect(result.actions).toContainEqual(
      expect.objectContaining({ kind: "chmod", ok: true, path: legacyAuthPath, mode: 0o600 }),
    );
    expectPerms((await fs.stat(legacyAuthPath)).mode & 0o777, 0o600);
  });

  it.runIf(process.platform !== "win32")(
    "tightens only includes accepted by the config include resolver",
    async () => {
      const stateDir = await createStateDir("include-boundary");
      const configPath = path.join(stateDir, "openclaw.json");
      const safeIncludePath = path.join(stateDir, "safe.json5");
      const escapedIncludePath = path.join(fixtureRoot, "escaped.json5");
      await fs.writeFile(safeIncludePath, "{}\n", "utf-8");
      await fs.writeFile(escapedIncludePath, "{}\n", "utf-8");
      await fs.chmod(safeIncludePath, 0o644);
      await fs.chmod(escapedIncludePath, 0o644);
      await fs.writeFile(
        configPath,
        '{ "$include": ["./safe.json5", "../escaped.json5"] }\n',
        "utf-8",
      );

      const result = await fixSecurityFootguns({
        env: createFixEnv(stateDir, configPath),
        stateDir,
        configPath,
      });

      expect(result.actions.some((action) => action.path === escapedIncludePath)).toBe(false);
      expectPerms((await fs.stat(safeIncludePath)).mode & 0o777, 0o600);
      expectPerms((await fs.stat(escapedIncludePath)).mode & 0o777, 0o644);
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps explicitly allowed include roots in the permission target set",
    async () => {
      const stateDir = await createStateDir("include-allowed-root");
      const configPath = path.join(stateDir, "openclaw.json");
      const sharedDir = path.join(fixtureRoot, "shared-includes");
      const sharedIncludePath = path.join(sharedDir, "shared.json5");
      await fs.mkdir(sharedDir, { recursive: true });
      await fs.writeFile(sharedIncludePath, "{}\n", "utf-8");
      await fs.chmod(sharedIncludePath, 0o644);
      const canonicalSharedIncludePath = await fs.realpath(sharedIncludePath);
      await fs.writeFile(
        configPath,
        `{ "$include": ${JSON.stringify(sharedIncludePath)} }\n`,
        "utf-8",
      );

      const result = await fixSecurityFootguns({
        env: {
          ...createFixEnv(stateDir, configPath),
          OPENCLAW_INCLUDE_ROOTS: sharedDir,
        },
        stateDir,
        configPath,
      });

      expect(result.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "chmod",
            ok: true,
            path: canonicalSharedIncludePath,
            mode: 0o600,
          }),
        ]),
      );
      expectPerms((await fs.stat(sharedIncludePath)).mode & 0o777, 0o600);
    },
  );
});
