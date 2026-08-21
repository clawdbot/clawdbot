// Npm Onboard Channel Agent Assertions tests cover npm onboard channel agent assertions script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const assertionsPath = path.resolve("scripts/e2e/lib/npm-onboard-channel-agent/assertions.mjs");
const disableExperimentalWarning = "--disable-warning=ExperimentalWarning";

function nodeOptionsWithoutExperimentalWarnings(): string {
  const current = process.env.NODE_OPTIONS ?? "";
  return current.includes(disableExperimentalWarning)
    ? current
    : [current, disableExperimentalWarning].filter(Boolean).join(" ");
}

function writeConfig(home: string, channels: Record<string, unknown>): void {
  const configDir = path.join(home, ".openclaw");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "openclaw.json"), JSON.stringify({ channels }));
}

function writeOnboardConfig(home: string): void {
  const configDir = path.join(home, ".openclaw");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "openclaw.json"),
    JSON.stringify({
      auth: {
        profiles: {
          "openai:api-key": { provider: "openai", mode: "api_key" },
        },
      },
    }),
  );
}

function writeCurrentAuthProfileStoreSqlite(home: string, store: unknown): void {
  const stateDir = path.join(home, ".openclaw", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(path.join(stateDir, "openclaw.sqlite"));
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_profile_stores (
        store_key TEXT NOT NULL PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `
        INSERT INTO auth_profile_stores (store_key, store_json, updated_at)
        VALUES (?, ?, ?)
      `,
    ).run("shared", JSON.stringify(store), Date.now());
  } finally {
    db.close();
  }
}

function writeLegacyAuthProfileStoreSqlite(home: string, store: unknown): void {
  const agentDir = path.join(home, ".openclaw", "agents", "main", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_profile_store (
        store_key TEXT NOT NULL PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `
        INSERT INTO auth_profile_store (store_key, store_json, updated_at)
        VALUES (?, ?, ?)
      `,
    ).run("primary", JSON.stringify(store), Date.now());
  } finally {
    db.close();
  }
}

function runAssert(home: string, channel: string, ...tokens: string[]) {
  return spawnSync(
    process.execPath,
    [assertionsPath, "assert-channel-config", channel, ...tokens],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(),
      },
    },
  );
}

function runOnboardAssert(home: string, layout: "current" | "legacy") {
  return spawnSync(process.execPath, [assertionsPath, "assert-onboard-state", layout, home], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(),
    },
  });
}

function runMockModelAssert(home: string, command: string, port: string) {
  return spawnSync(process.execPath, [assertionsPath, command, port], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(),
    },
  });
}

function runStatusAssert(
  channel: string,
  channelsStatus: unknown,
  statusText: string,
  env: NodeJS.ProcessEnv = {},
) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-status-assertions-"));
  try {
    const channelsStatusPath = path.join(tempDir, "channels-status.json");
    const statusTextPath = path.join(tempDir, "status.txt");
    fs.writeFileSync(channelsStatusPath, JSON.stringify(channelsStatus));
    fs.writeFileSync(statusTextPath, statusText);
    return spawnSync(
      process.execPath,
      [assertionsPath, "assert-status-surfaces", channel, channelsStatusPath, statusTextPath],
      {
        encoding: "utf8",
        env: { ...process.env, ...env },
      },
    );
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
}

describe("npm onboard channel agent assertions", () => {
  it("rejects loose mock OpenAI port args", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-onboard-assertions-"));

    try {
      for (const command of ["configure-mock-model", "assert-mock-model-config"]) {
        const result = runMockModelAssert(tempDir, command, "1e3");

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("mock OpenAI port must be a TCP port from 1 to 65535");
        expect(result.stderr).toContain('"1e3"');
      }
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("configures and validates the canonical main agent's mock model", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-onboard-mock-agent-"));
    const configPath = path.join(home, ".openclaw", "openclaw.json");

    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          agents: {
            defaults: { models: {} },
            entries: { main: { default: true, model: "openai/gpt-5.6" } },
          },
          models: { providers: {} },
        }),
      );

      expect(runMockModelAssert(home, "configure-mock-model", "18181").status).toBe(0);
      expect(runMockModelAssert(home, "assert-mock-model-config", "18181").status).toBe(0);

      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        agents: {
          entries: Record<
            string,
            {
              default?: boolean;
              model?: { primary?: string };
              models?: Record<string, { agentRuntime?: { id?: string } }>;
            }
          >;
        };
      };
      expect(cfg.agents.entries.main).toMatchObject({
        default: true,
        model: { primary: "openai/gpt-5.6-luna" },
        models: {
          "openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } },
        },
      });
    } finally {
      fs.rmSync(home, { force: true, recursive: true });
    }
  });

  it("rejects a canonical main agent that does not use the configured mock model", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-onboard-mock-agent-"));
    const configPath = path.join(home, ".openclaw", "openclaw.json");

    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          agents: {
            defaults: { models: {} },
            entries: { main: { default: true, model: "openai/gpt-5.6" } },
          },
          models: { providers: {} },
        }),
      );
      expect(runMockModelAssert(home, "configure-mock-model", "18181").status).toBe(0);

      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        agents: { entries: Record<string, { model?: { primary?: string } }> };
      };
      const mainAgent = cfg.agents.entries.main;
      if (!mainAgent) {
        throw new Error("mock configuration did not contain the main agent");
      }
      mainAgent.model = { primary: "openai/gpt-5.6" };
      fs.writeFileSync(configPath, JSON.stringify(cfg));

      const result = runMockModelAssert(home, "assert-mock-model-config", "18181");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("mock agent model was not preserved");
    } finally {
      fs.rmSync(home, { force: true, recursive: true });
    }
  });

  it.each([
    ["legacy", writeLegacyAuthProfileStoreSqlite],
    ["current", writeCurrentAuthProfileStoreSqlite],
  ] as const)(
    "validates OpenAI env refs from the %s SQLite auth profile store",
    (layout, writeStore) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-onboard-assertions-"));

      try {
        writeOnboardConfig(tempDir);
        writeStore(tempDir, {
          version: 1,
          profiles: {
            "openai:api-key": {
              type: "api_key",
              provider: "openai",
              keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            },
          },
        });

        const result = runOnboardAssert(tempDir, layout);

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
      } finally {
        fs.rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  it("rejects auth profile stores without a usable OpenAI env ref", () => {
    const cases: unknown[] = [
      "OPENAI_API_KEY",
      {
        version: 1,
        profiles: {
          "openai:api-key": { note: "OPENAI_API_KEY" },
        },
      },
    ];

    for (const store of cases) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-onboard-assertions-"));

      try {
        writeOnboardConfig(tempDir);
        writeCurrentAuthProfileStoreSqlite(tempDir, store);

        const result = runOnboardAssert(tempDir, "current");

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("auth profile did not persist OPENAI_API_KEY env ref");
      } finally {
        fs.rmSync(tempDir, { force: true, recursive: true });
      }
    }
  });

  it("rejects inline OpenAI keys in the SQLite auth profile store", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-onboard-assertions-"));
    try {
      writeOnboardConfig(tempDir);
      writeCurrentAuthProfileStoreSqlite(tempDir, {
        version: 1,
        profiles: {
          "openai:api-key": {
            type: "api_key",
            provider: "openai",
            key: "sk-openclaw-npm-onboard-e2e",
          },
        },
      });

      const result = runOnboardAssert(tempDir, "current");

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("auth profile persisted the raw OpenAI test key");
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("rejects mixed legacy and current auth profile stores", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-onboard-assertions-"));

    try {
      writeOnboardConfig(tempDir);
      const store = {
        version: 1,
        profiles: {
          "openai:api-key": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
      };
      writeLegacyAuthProfileStoreSqlite(tempDir, store);
      writeCurrentAuthProfileStoreSqlite(tempDir, store);

      const result = runOnboardAssert(tempDir, "current");

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "onboard persisted mixed legacy and current auth profile stores",
      );
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it.each([
    ["current", "legacy", writeCurrentAuthProfileStoreSqlite],
    ["legacy", "current", writeLegacyAuthProfileStoreSqlite],
  ] as const)(
    "rejects the %s layout when the candidate requires %s",
    (observedLayout, expectedLayout, writeStore) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-onboard-assertions-"));

      try {
        writeOnboardConfig(tempDir);
        writeStore(tempDir, {
          version: 1,
          profiles: {
            "openai:api-key": {
              type: "api_key",
              provider: "openai",
              keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            },
          },
        });

        const result = runOnboardAssert(tempDir, expectedLayout);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          `onboard persisted ${observedLayout} auth profile store; expected ${expectedLayout}`,
        );
      } finally {
        fs.rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  it("keeps the current-layout ban on the retired main-agent database", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-onboard-assertions-"));
    const legacyAgentDir = path.join(tempDir, ".openclaw", "agents", "main", "agent");

    try {
      writeOnboardConfig(tempDir);
      writeCurrentAuthProfileStoreSqlite(tempDir, {
        version: 1,
        profiles: {
          "openai:api-key": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
      });
      fs.mkdirSync(legacyAgentDir, { recursive: true });
      new DatabaseSync(path.join(legacyAgentDir, "openclaw-agent.sqlite")).close();

      const result = runOnboardAssert(tempDir, "current");

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("onboard created the retired main-agent auth database");
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("rejects a missing auth profile store", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-onboard-assertions-"));

    try {
      writeOnboardConfig(tempDir);

      const result = runOnboardAssert(tempDir, "legacy");

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("onboard did not persist auth profile store");
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("validates channel tokens in their canonical config fields", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-assertions-"));
    try {
      writeConfig(tempDir, {
        discord: { enabled: true, token: "discord-token" },
        slack: { enabled: true, appToken: "xapp-token", botToken: "xoxb-token" },
        telegram: { enabled: true, botToken: "telegram-token" },
      });

      expect(runAssert(tempDir, "telegram", "telegram-token").status).toBe(0);
      expect(runAssert(tempDir, "discord", "discord-token").status).toBe(0);
      expect(runAssert(tempDir, "slack", "xoxb-token", "xapp-token").status).toBe(0);
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("rejects tokens persisted on the wrong channel config field", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-assertions-"));
    try {
      writeConfig(tempDir, {
        telegram: { enabled: true, token: "telegram-token" },
      });

      const result = runAssert(tempDir, "telegram", "telegram-token");

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("telegram config did not persist botToken");
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("validates configured channels in the plain status Channels section", () => {
    const result = runStatusAssert(
      "telegram",
      { configuredChannels: ["telegram"] },
      [
        "# OpenClaw status",
        "",
        "# Overview",
        "OS macOS",
        "",
        "# Channels",
        "Channel State Detail",
        "telegram ok configured",
        "",
        "# Sessions",
        "No sessions",
      ].join("\n"),
    );

    expect(result.status).toBe(0);
  });

  it("rejects plain status output that mentions the channel outside the Channels section", () => {
    const result = runStatusAssert(
      "telegram",
      { configuredChannels: ["telegram"] },
      [
        "# OpenClaw status",
        "",
        "# Overview",
        "OS macOS",
        "",
        "# Channels",
        "No channels configured",
        "",
        "# Sessions",
        "telegram appeared in an unrelated session note",
      ].join("\n"),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "plain status output did not mention telegram in the Channels section",
    );
  });

  it("rejects oversized plain status output before parsing it", () => {
    const result = runStatusAssert(
      "telegram",
      { configuredChannels: ["telegram"] },
      `# OpenClaw status\n${"x".repeat(128)}`,
      { OPENCLAW_NPM_ONBOARD_STATUS_TEXT_MAX_BYTES: "64" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("plain status output exceeded 64 bytes");
  });

  it("rejects oversized channels status JSON before parsing it", () => {
    const result = runStatusAssert(
      "telegram",
      { configuredChannels: ["telegram"], filler: "x".repeat(128) },
      "# Channels\ntelegram ok configured",
      { OPENCLAW_NPM_ONBOARD_JSON_ARTIFACT_MAX_BYTES: "64" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("JSON artifact exceeded 64 bytes");
  });
});
