import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigIO, resetConfigRuntimeState } from "../../../config/io.js";
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
            defaults: { model: "${DEFAULT_MODEL}" },
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
});
