import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigIO, resetConfigRuntimeState } from "../../../config/io.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

const roots: string[] = [];

afterEach(async () => {
  resetConfigRuntimeState();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("default role materialization authored writes", () => {
  it("preserves env references and includes and is idempotent after persistence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-default-roles-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    const channelsPath = path.join(root, "channels.json5");
    const includeRaw = `${JSON.stringify({ telegram: { enabled: true } }, null, 2)}\n`;
    await fs.writeFile(channelsPath, includeRaw, "utf-8");
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          agents: {
            defaults: { model: "${DEFAULT_MODEL}", workspace: "/srv/ops" },
            entries: {
              ops: { default: true },
              research: { model: "${RESEARCH_MODEL}" },
            },
          },
          channels: { $include: "./channels.json5" },
          talk: { provider: "test" },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const io = createConfigIO({
      configPath,
      env: {
        HOME: root,
        OPENCLAW_TEST_FAST: "1",
        DEFAULT_MODEL: "openai/default-model",
        RESEARCH_MODEL: "openai/research-model",
      } as NodeJS.ProcessEnv,
      homedir: () => root,
      observe: false,
      logger: { warn: () => {}, error: () => {} },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.config.agents?.entries?.ops).not.toHaveProperty("default");
    expect(snapshot.config.agents?.defaults?.heartbeat?.agentId).toBe("ops");
    const doctorCandidate = {
      ...snapshot.config,
      agents: { ...snapshot.config.agents, ownership: "explicit" as const },
    };
    await io.writeConfigFile(doctorCandidate, {
      baseSnapshot: snapshot,
      explicitSetPaths: [
        ["agents", "entries"],
        ["agents", "ownership"],
      ],
      explicitSetValueSource: doctorCandidate,
    });

    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as OpenClawConfig;
    expect(persisted.agents?.defaults?.model).toBe("${DEFAULT_MODEL}");
    expect(persisted.agents?.entries?.ops?.workspace).toBe("/srv/ops");
    expect(persisted.agents?.ownership).toBe("explicit");
    expect(persisted.agents?.entries?.research?.model).toBe("${RESEARCH_MODEL}");
    expect(persisted.agents?.entries?.ops).not.toHaveProperty("default");
    expect(persisted.channels).toEqual({ $include: "./channels.json5" });
    await expect(fs.readFile(channelsPath, "utf-8")).resolves.toBe(includeRaw);
    expect(persisted.bindings).toContainEqual({
      agentId: "ops",
      match: { channel: "telegram", accountId: "*" },
    });
    expect(persisted.agents?.defaults?.heartbeat?.agentId).toBe("ops");
    expect(persisted.agents?.defaults?.authInheritance?.agentId).toBe("ops");
    expect(persisted.talk?.agentId).toBe("ops");

    const firstPersisted = await fs.readFile(configPath, "utf-8");
    const reread = await io.readConfigFileSnapshot();
    await io.writeConfigFile(reread.config, { baseSnapshot: reread });
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(firstPersisted);

    const topology = await io.readConfigFileSnapshot();
    await io.writeConfigFile(
      {
        ...topology.config,
        agents: {
          ...topology.config.agents,
          ownership: undefined,
          entries: { ...topology.config.agents?.entries, writer: {} },
        },
      },
      { baseSnapshot: topology },
    );
    const rewritten = JSON.parse(await fs.readFile(configPath, "utf-8"));
    expect(rewritten.agents).toMatchObject({ ownership: "explicit", entries: { writer: {} } });
  });

  it.each([true, false])(
    "pins a replaced sole fixed-store owner only when the store is unchanged: %s",
    async (sameStore) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-owner-"));
      roots.push(root);
      const configPath = path.join(root, "openclaw.json");
      const sourceStore = path.join(root, "source-sessions.json");
      await fs.writeFile(
        configPath,
        JSON.stringify({ agents: { entries: { ops: {} } }, session: { store: sourceStore } }),
      );
      const io = createConfigIO({
        configPath,
        env: { HOME: root, OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => root,
        observe: false,
        logger: { warn: () => {}, error: () => {} },
      });
      const snapshot = await io.readConfigFileSnapshot();
      await io.writeConfigFile(
        {
          ...snapshot.config,
          agents: { ownership: "explicit", entries: { research: {} } },
          session: {
            store: sameStore ? sourceStore : path.join(root, "destination-sessions.json"),
          },
        },
        { baseSnapshot: snapshot, allowedAgentRosterRemovals: ["ops"] },
      );
      const persisted = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(persisted.agents?.defaults?.sessionStore?.agentId).toBe(sameStore ? "ops" : undefined);
    },
  );

  it.each([
    ["another fixed store", "destination-sessions.json"],
    ["a per-agent store", "sessions-{agentId}.json"],
  ])("drops a persisted fixed-store owner when switching to %s", async (_label, storeName) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-owner-switch-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
        session: { store: path.join(root, "source-sessions.json") },
      }),
    );
    const io = createConfigIO({
      configPath,
      env: { HOME: root, OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      homedir: () => root,
      observe: false,
      logger: { warn: () => {}, error: () => {} },
    });
    const snapshot = await io.readConfigFileSnapshot();

    await io.writeConfigFile(
      {
        ...snapshot.config,
        session: { ...snapshot.config.session, store: path.join(root, storeName) },
      },
      { baseSnapshot: snapshot },
    );

    const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
    expect(persisted.agents?.defaults?.sessionStore?.agentId).toBeUndefined();
  });

  it("keeps an explicitly supplied owner when switching fixed stores", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-owner-switch-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
        session: { store: path.join(root, "source-sessions.json") },
      }),
    );
    const io = createConfigIO({
      configPath,
      env: { HOME: root, OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      homedir: () => root,
      observe: false,
      logger: { warn: () => {}, error: () => {} },
    });
    const snapshot = await io.readConfigFileSnapshot();
    const nextConfig: OpenClawConfig = {
      ...snapshot.config,
      agents: {
        ...snapshot.config.agents,
        defaults: {
          ...snapshot.config.agents?.defaults,
          sessionStore: { agentId: "research" },
        },
      },
      session: { ...snapshot.config.session, store: path.join(root, "destination-sessions.json") },
    };

    await io.writeConfigFile(nextConfig, {
      baseSnapshot: snapshot,
      explicitSetPaths: [["agents", "defaults", "sessionStore", "agentId"]],
      explicitSetValueSource: nextConfig,
    });

    const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
    expect(persisted.agents?.defaults?.sessionStore?.agentId).toBe("research");
  });

  it("pins the survivor's previous workspace during a generic roster collapse", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-collapse-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          ownership: "explicit",
          defaults: { workspace: "/srv/fleet" },
          entries: { ops: {}, research: {} },
        },
      }),
    );
    const io = createConfigIO({
      configPath,
      env: { HOME: root, OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      homedir: () => root,
      observe: false,
      logger: { warn: () => {}, error: () => {} },
    });
    const snapshot = await io.readConfigFileSnapshot();

    await io.writeConfigFile(
      {
        ...snapshot.config,
        agents: {
          ...snapshot.config.agents,
          ownership: undefined,
          entries: { research: {} },
        },
      },
      { baseSnapshot: snapshot, allowedAgentRosterRemovals: ["ops"] },
    );

    const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
    expect(persisted.agents?.entries?.research?.workspace).toBe("/srv/fleet/research");
  });

  it.each([
    ["pins the replaced owner", "research", false, "ops"],
    ["keeps an explicitly authored owner", "research", true, "research"],
    ["does nothing when the owner is unchanged", "ops", false, undefined],
  ] as const)(
    "%s during generic roster writes",
    async (_label, targetAgentId, explicit, expected) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-owner-transition-"));
      roots.push(root);
      const configPath = path.join(root, "openclaw.json");
      await fs.writeFile(configPath, JSON.stringify({ agents: { entries: { ops: {} } } }));
      const io = createConfigIO({
        configPath,
        env: { HOME: root, OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => root,
        observe: false,
        logger: { warn: () => {}, error: () => {} },
      });
      const snapshot = await io.readConfigFileSnapshot();
      const nextConfig: OpenClawConfig = {
        ...snapshot.config,
        agents: {
          ownership: "explicit",
          ...(explicit ? { defaults: { authInheritance: { agentId: "research" } } } : {}),
          entries: { [targetAgentId]: targetAgentId === "ops" ? { model: "openai/test" } : {} },
        },
      };
      await io.writeConfigFile(nextConfig, {
        baseSnapshot: snapshot,
        ...(targetAgentId === "research" ? { allowedAgentRosterRemovals: ["ops"] } : {}),
        explicitSetPaths: [
          ["agents", "entries"],
          ...(explicit ? [["agents", "defaults", "authInheritance"]] : []),
        ],
        explicitSetValueSource: nextConfig,
      });

      const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
      expect(persisted.agents?.defaults?.authInheritance?.agentId).toBe(expected);
    },
  );

  it("refuses to remove an inherited-auth owner with a custom agentDir", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-custom-auth-owner-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    const customAgentDir = path.join(root, "custom-ops-agent");
    await fs.writeFile(
      configPath,
      JSON.stringify({ agents: { entries: { ops: { agentDir: customAgentDir } } } }),
    );
    const io = createConfigIO({
      configPath,
      env: { HOME: root, OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      homedir: () => root,
      observe: false,
      logger: { warn: () => {}, error: () => {} },
    });
    const snapshot = await io.readConfigFileSnapshot();

    await expect(
      io.writeConfigFile(
        {
          ...snapshot.config,
          agents: { ownership: "explicit", entries: { research: {} } },
        },
        { baseSnapshot: snapshot, allowedAgentRosterRemovals: ["ops"] },
      ),
    ).rejects.toMatchObject({
      code: "CONFIG_WRITE_REJECTED",
      message: expect.stringContaining("set agents.defaults.authInheritance explicitly"),
    });
  });

  it("replaces a legacy list when persisting explicit ownership", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-roster-write-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          list: [
            { id: "ops", default: true, workspace: "/srv/ops" },
            { id: "research", model: "openai/research" },
          ],
        },
      }),
    );
    const io = createConfigIO({
      configPath,
      env: { HOME: root, OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      homedir: () => root,
      observe: false,
      logger: { warn: () => {}, error: () => {} },
    });
    const snapshot = await io.readConfigFileSnapshot();
    const nextConfig: OpenClawConfig = {
      ...snapshot.config,
      agents: { ...snapshot.config.agents, ownership: "explicit" },
    };

    await io.writeConfigFile(nextConfig, {
      baseSnapshot: snapshot,
      explicitSetPaths: [["agents", "ownership"]],
      explicitSetValueSource: nextConfig,
    });

    const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
    expect(persisted.agents).toEqual({
      ownership: "explicit",
      defaults: {
        heartbeat: { agentId: "ops" },
        systemAgent: { agentId: "ops" },
        authInheritance: { agentId: "ops" },
      },
      entries: {
        ops: { workspace: "/srv/ops" },
        research: { model: "openai/research" },
      },
    });
    expect(persisted.agents).not.toHaveProperty("list");
    const firstPersisted = await fs.readFile(configPath, "utf8");
    const reread = await io.readConfigFileSnapshot();
    await io.writeConfigFile(reread.config, { baseSnapshot: reread });
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(firstPersisted);
  });

  it("preserves migrated legacy ownership during an unrelated write", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-owner-roundtrip-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          entries: {
            ops: {},
            research: { default: true },
          },
        },
        gateway: { port: 18789 },
      }),
    );
    const io = createConfigIO({
      configPath,
      env: { HOME: root, OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      homedir: () => root,
      observe: false,
      logger: { warn: () => {}, error: () => {} },
    });
    const snapshot = await io.readConfigFileSnapshot();
    expect(tryResolveLegacyCompatibilityAgentId(snapshot.config)).toBe("research");

    await io.writeConfigFile(
      { ...snapshot.config, gateway: { ...snapshot.config.gateway, port: 19001 } },
      { baseSnapshot: snapshot, explicitSetPaths: [["gateway", "port"]] },
    );

    const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
    expect(persisted.agents?.ownership).toBeUndefined();
    expect(persisted.agents?.entries?.research?.default).toBe(true);
    const reread = await io.readConfigFileSnapshot();
    expect(tryResolveLegacyCompatibilityAgentId(reread.config)).toBe("research");
  });
});
