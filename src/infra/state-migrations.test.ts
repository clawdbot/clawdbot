import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveChannelAllowFromPath } from "../pairing/pairing-store.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { detectLegacyStateMigrations, runLegacyStateMigrations } from "./state-migrations.js";

vi.mock("../channels/plugins/bundled.js", () => {
  function fileExists(filePath: string): boolean {
    try {
      return fsSync.statSync(filePath).isFile();
    } catch {
      return false;
    }
  }

  function resolveChatAppAccountId(cfg: OpenClawConfig): string {
    const channel = (cfg.channels as Record<string, { defaultAccount?: string }> | undefined)
      ?.chatapp;
    return channel?.defaultAccount ?? "default";
  }

  return {
    listBundledChannelLegacySessionSurfaces: vi.fn(() => [
      {
        isLegacyGroupSessionKey: (key: string) => /^group:mobile-/i.test(key.trim()),
        canonicalizeLegacySessionKey: ({ key, agentId }: { key: string; agentId: string }) =>
          /^group:mobile-/i.test(key.trim())
            ? `agent:${agentId}:mobileauth:${key.trim().toLowerCase()}`
            : null,
      },
    ]),
    listBundledChannelLegacyStateMigrationDetectors: vi.fn(() => [
      ({ oauthDir }: { oauthDir: string }) => {
        let entries: fsSync.Dirent[] = [];
        try {
          entries = fsSync.readdirSync(oauthDir, { withFileTypes: true });
        } catch {
          return [];
        }
        return entries.flatMap((entry) => {
          if (!entry.isFile() || !/^(creds|pre-key-1)\.json$/u.test(entry.name)) {
            return [];
          }
          const sourcePath = path.join(oauthDir, entry.name);
          const targetPath = path.join(oauthDir, "mobileauth", "default", entry.name);
          return fileExists(targetPath)
            ? []
            : [
                {
                  kind: "move" as const,
                  label: `MobileAuth auth ${entry.name}`,
                  sourcePath,
                  targetPath,
                },
              ];
        });
      },
      ({ cfg, env }: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv }) => {
        const root = env.OPENCLAW_STATE_DIR;
        if (!root) {
          return [];
        }
        const sourcePath = path.join(root, "credentials", "chatapp-allowFrom.json");
        const targetPath = path.join(
          root,
          "credentials",
          `chatapp-${resolveChatAppAccountId(cfg)}-allowFrom.json`,
        );
        return fileExists(sourcePath) && !fileExists(targetPath)
          ? [{ kind: "copy" as const, label: "ChatApp pairing allowFrom", sourcePath, targetPath }]
          : [];
      },
    ]),
  };
});

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-state-migrations-test-");

function createConfig(): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "worker-1", default: true }],
    },
    session: {
      mainKey: "desk",
    },
    channels: {
      chatapp: {
        defaultAccount: "alpha",
        accounts: {
          beta: {},
          alpha: {},
        },
      },
    },
  } as OpenClawConfig;
}

function createEnv(stateDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
  };
}

async function createLegacyStateFixture(params?: { includePreKey?: boolean }) {
  const root = await createTempDir();
  const stateDir = path.join(root, ".openclaw");
  const env = createEnv(stateDir);
  const cfg = createConfig();

  await fs.mkdir(path.join(stateDir, "sessions"), { recursive: true });
  await fs.mkdir(path.join(stateDir, "agents", "worker-1", "sessions"), { recursive: true });
  await fs.mkdir(path.join(stateDir, "agent"), { recursive: true });
  await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true });

  await fs.writeFile(
    path.join(stateDir, "sessions", "sessions.json"),
    `${JSON.stringify({ legacyDirect: { sessionId: "legacy-direct", updatedAt: 10 } }, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(stateDir, "sessions", "trace.jsonl"), "{}\n", "utf8");
  await fs.writeFile(
    path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json"),
    `${JSON.stringify(
      {
        "group:mobile-room": { sessionId: "group-session", updatedAt: 5 },
        "group:legacy-room": { sessionId: "generic-group-session", updatedAt: 4 },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(stateDir, "agent", "settings.json"), '{"ok":true}\n', "utf8");
  await fs.writeFile(path.join(stateDir, "credentials", "creds.json"), '{"auth":true}\n', "utf8");
  if (params?.includePreKey) {
    await fs.writeFile(
      path.join(stateDir, "credentials", "pre-key-1.json"),
      '{"preKey":true}\n',
      "utf8",
    );
  }
  await fs.writeFile(path.join(stateDir, "credentials", "oauth.json"), '{"oauth":true}\n', "utf8");
  await fs.writeFile(resolveChannelAllowFromPath("chatapp", env), '["123","456"]\n', "utf8");

  return {
    root,
    stateDir,
    env,
    cfg,
  };
}

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("state migrations", () => {
  it("detects legacy sessions, agent files, channel auth, and allowFrom copies", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });

    expect(detected.targetAgentId).toBe("worker-1");
    expect(detected.targetMainKey).toBe("desk");
    expect(detected.sessions.hasLegacy).toBe(true);
    expect(detected.sessions.legacyKeys).toEqual(["group:mobile-room", "group:legacy-room"]);
    expect(detected.agentDir.hasLegacy).toBe(true);
    expect(detected.channelPlans.hasLegacy).toBe(true);
    expect(detected.channelPlans.plans.map((plan) => plan.targetPath)).toEqual([
      path.join(stateDir, "credentials", "mobileauth", "default", "creds.json"),
      resolveChannelAllowFromPath("chatapp", env, "alpha"),
    ]);
    expect(detected.preview).toEqual([
      `- Sessions: ${path.join(stateDir, "sessions")} → ${path.join(stateDir, "agents", "worker-1", "sessions")}`,
      `- Sessions: canonicalize legacy keys in ${path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json")}`,
      `- Agent dir: ${path.join(stateDir, "agent")} → ${path.join(stateDir, "agents", "worker-1", "agent")}`,
      `- MobileAuth auth creds.json: ${path.join(stateDir, "credentials", "creds.json")} → ${path.join(stateDir, "credentials", "mobileauth", "default", "creds.json")}`,
      `- ChatApp pairing allowFrom: ${resolveChannelAllowFromPath("chatapp", env)} → ${resolveChannelAllowFromPath("chatapp", env, "alpha")}`,
    ]);
  });

  it("runs legacy state migrations and canonicalizes the merged session store", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture({ includePreKey: true });

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({
      detected,
      now: () => 1234,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      `Migrated latest direct-chat session → agent:worker-1:desk`,
      `Merged sessions store → ${path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json")}`,
      "Canonicalized 2 legacy session key(s)",
      "Moved trace.jsonl → agents/worker-1/sessions",
      "Moved agent file settings.json → agents/worker-1/agent",
      `Moved MobileAuth auth creds.json → ${path.join(stateDir, "credentials", "mobileauth", "default", "creds.json")}`,
      `Moved MobileAuth auth pre-key-1.json → ${path.join(stateDir, "credentials", "mobileauth", "default", "pre-key-1.json")}`,
      `Copied ChatApp pairing allowFrom → ${resolveChannelAllowFromPath("chatapp", env, "alpha")}`,
    ]);

    const mergedStore = JSON.parse(
      await fs.readFile(
        path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json"),
        "utf8",
      ),
    ) as Record<string, { sessionId: string }>;
    expect(mergedStore["agent:worker-1:desk"]?.sessionId).toBe("legacy-direct");
    expect(mergedStore["agent:worker-1:mobileauth:group:mobile-room"]?.sessionId).toBe(
      "group-session",
    );
    expect(mergedStore["agent:worker-1:unknown:group:legacy-room"]?.sessionId).toBe(
      "generic-group-session",
    );

    await expect(
      fs.readFile(path.join(stateDir, "agents", "worker-1", "sessions", "trace.jsonl"), "utf8"),
    ).resolves.toBe("{}\n");
    await expect(fs.stat(path.join(stateDir, "sessions", "sessions.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(path.join(stateDir, "sessions", "trace.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(
      fs.readFile(path.join(stateDir, "agents", "worker-1", "agent", "settings.json"), "utf8"),
    ).resolves.toContain('"ok":true');
    await expect(
      fs.readFile(
        path.join(stateDir, "credentials", "mobileauth", "default", "creds.json"),
        "utf8",
      ),
    ).resolves.toContain('"auth":true');
    await expect(
      fs.readFile(
        path.join(stateDir, "credentials", "mobileauth", "default", "pre-key-1.json"),
        "utf8",
      ),
    ).resolves.toContain('"preKey":true');
    await expect(
      fs.readFile(path.join(stateDir, "credentials", "oauth.json"), "utf8"),
    ).resolves.toContain('"oauth":true');
    await expect(
      fs.readFile(resolveChannelAllowFromPath("chatapp", env, "alpha"), "utf8"),
    ).resolves.toBe('["123","456"]\n');
    await expect(
      fs.stat(resolveChannelAllowFromPath("chatapp", env, "default")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(resolveChannelAllowFromPath("chatapp", env, "beta")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
