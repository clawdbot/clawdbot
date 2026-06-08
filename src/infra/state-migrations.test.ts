// Covers legacy state migration detection and repair behavior.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore } from "../config/sessions/store.js";
import { resolveChannelAllowFromPath } from "../pairing/pairing-store.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
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
        let entries: fsSync.Dirent[];
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

async function expectMissingPath(targetPath: string): Promise<void> {
  let statError: NodeJS.ErrnoException | undefined;
  try {
    await fs.stat(targetPath);
  } catch (error) {
    statError = error as NodeJS.ErrnoException;
  }
  expect(statError).toBeInstanceOf(Error);
  expect(statError?.code).toBe("ENOENT");
  expect(statError?.path).toBe(targetPath);
  expect(statError?.syscall).toBe("stat");
}
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
  vi.useRealTimers();
  await tempDirs.cleanup();
});

describe("state migrations", () => {
  let detectionCase: Awaited<ReturnType<typeof detectLegacyStateMigrations>> & {
    stateDir: string;
    env: NodeJS.ProcessEnv;
  };

  beforeAll(async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    detectionCase = { ...detected, stateDir, env };
  });

  it("detects legacy sessions, agent files, channel auth, and allowFrom copies", () => {
    expect(detectionCase.targetAgentId).toBe("worker-1");
    expect(detectionCase.targetMainKey).toBe("desk");
    expect(detectionCase.sessions.hasLegacy).toBe(true);
    expect(detectionCase.sessions.legacyKeys).toEqual(["group:mobile-room", "group:legacy-room"]);
    expect(detectionCase.agentDir.hasLegacy).toBe(true);
    expect(detectionCase.channelPlans.hasLegacy).toBe(true);
    expect(detectionCase.channelPlans.plans.map((plan) => plan.targetPath)).toEqual([
      path.join(detectionCase.stateDir, "credentials", "mobileauth", "default", "creds.json"),
      resolveChannelAllowFromPath("chatapp", detectionCase.env, "alpha"),
    ]);
    expect(detectionCase.preview).toEqual([
      `- Sessions: ${path.join(detectionCase.stateDir, "sessions")} → ${path.join(detectionCase.stateDir, "agents", "worker-1", "sessions")}`,
      `- Sessions: canonicalize legacy keys in ${path.join(detectionCase.stateDir, "agents", "worker-1", "sessions", "sessions.json")}`,
      `- Sessions: ${path.join(detectionCase.stateDir, "agents", "worker-1", "sessions", "sessions.json")} → agent SQLite state`,
      `- Agent dir: ${path.join(detectionCase.stateDir, "agent")} → ${path.join(detectionCase.stateDir, "agents", "worker-1", "agent")}`,
      `- MobileAuth auth creds.json: ${path.join(detectionCase.stateDir, "credentials", "creds.json")} → ${path.join(detectionCase.stateDir, "credentials", "mobileauth", "default", "creds.json")}`,
      `- ChatApp pairing allowFrom: ${resolveChannelAllowFromPath("chatapp", detectionCase.env)} → ${resolveChannelAllowFromPath("chatapp", detectionCase.env, "alpha")}`,
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

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toEqual([
      `Migrated latest direct-chat session → agent:worker-1:desk`,
      "Imported 4 session metadata row(s) → agent SQLite state",
      "Canonicalized 2 legacy session key(s)",
      "Moved trace.jsonl → agents/worker-1/sessions",
      "Moved agent file settings.json → agents/worker-1/agent",
      `Moved MobileAuth auth creds.json → ${path.join(stateDir, "credentials", "mobileauth", "default", "creds.json")}`,
      `Moved MobileAuth auth pre-key-1.json → ${path.join(stateDir, "credentials", "mobileauth", "default", "pre-key-1.json")}`,
      `Copied ChatApp pairing allowFrom → ${resolveChannelAllowFromPath("chatapp", env, "alpha")}`,
    ]);

    const targetStorePath = path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json");
    const mergedStore = loadSessionStore(targetStorePath, { skipCache: true }) as Record<
      string,
      { sessionId: string }
    >;
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
    await expectMissingPath(path.join(stateDir, "sessions", "sessions.json"));
    await expectMissingPath(targetStorePath);
    await expectMissingPath(path.join(stateDir, "sessions", "trace.jsonl"));

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
    await expectMissingPath(resolveChannelAllowFromPath("chatapp", env, "default"));
    await expectMissingPath(resolveChannelAllowFromPath("chatapp", env, "beta"));
  });

  it("preserves metadata-only session rows during legacy JSON import", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();
    const targetStorePath = path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json");
    const targetStore = JSON.parse(await fs.readFile(targetStorePath, "utf8")) as Record<
      string,
      unknown
    >;
    targetStore["agent:worker-1:metadata"] = {
      updatedAt: 8,
      groupActivation: "always",
    };
    await fs.writeFile(targetStorePath, `${JSON.stringify(targetStore, null, 2)}\n`, "utf8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({
      detected,
      now: () => 1234,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Imported 5 session metadata row(s) → agent SQLite state");
    const store = loadSessionStore(targetStorePath, { skipCache: true });
    expect(store["agent:worker-1:metadata"]).toMatchObject({
      groupActivation: "always",
    });
    expect(store["agent:worker-1:metadata"]?.sessionId).toBeUndefined();
    await expectMissingPath(targetStorePath);
  });

  it("runs plugin doctor session inspections after importing legacy JSON stores", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();
    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    const targetStorePath = path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json");
    const detectedWithPluginPlan = {
      ...detected,
      pluginPlans: {
        hasLegacy: true,
        plans: [
          {
            pluginId: "test-plugin",
            preview: ["- Test plugin session inspection"],
            migration: {
              id: "test-plugin-session-inspection",
              label: "Test plugin session inspection",
              detectLegacyState: () => ({ preview: ["- Test plugin session inspection"] }),
              migrateLegacyState: () => {
                const store = loadSessionStore(targetStorePath, { skipCache: true }) as Record<
                  string,
                  { sessionId?: string }
                >;
                return {
                  changes: [`Plugin saw ${store["agent:worker-1:desk"]?.sessionId ?? "missing"}`],
                  warnings: [],
                };
              },
            },
          },
        ],
      },
    };

    const result = await runLegacyStateMigrations({
      detected: detectedWithPluginPlan,
      config: cfg,
      now: () => 1234,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Plugin saw legacy-direct");
    expect(
      result.changes.indexOf("Imported 4 session metadata row(s) → agent SQLite state"),
    ).toBeLessThan(result.changes.indexOf("Plugin saw legacy-direct"));
  });

  it("migrates legacy delivery queue files into shared SQLite state", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    await fs.mkdir(path.join(stateDir, "delivery-queue"), { recursive: true });
    await fs.mkdir(path.join(stateDir, "delivery-queue", "failed"), { recursive: true });
    await fs.mkdir(path.join(stateDir, "session-delivery-queue"), { recursive: true });
    await fs.mkdir(path.join(stateDir, "session-delivery-queue", "failed"), { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "delivery-queue", "outbound-1.json"),
      JSON.stringify({
        id: "outbound-1",
        enqueuedAt: 10,
        retryCount: 2,
        channel: "telegram",
        to: "123",
        accountId: "main",
        payloads: [{ text: "hi" }],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(stateDir, "session-delivery-queue", "session-1.json"),
      JSON.stringify({
        id: "session-1",
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "resume",
        messageId: "m1",
        retryCount: 0,
        enqueuedAt: 20,
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(stateDir, "delivery-queue", "failed", "outbound-failed.json"),
      JSON.stringify({
        id: "outbound-failed",
        enqueuedAt: 30,
        retryCount: 3,
        channel: "telegram",
        to: "456",
        lastError: "permanent",
        payloads: [{ text: "nope" }],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(stateDir, "session-delivery-queue", "failed", "session-failed.json"),
      JSON.stringify({
        id: "session-failed",
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "failed resume",
        lastError: "expired",
        retryCount: 3,
        enqueuedAt: 40,
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(detected.deliveryQueues.hasLegacy).toBe(true);

    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain(
      "Migrated 2 outbound delivery queue entries → shared SQLite state",
    );
    expect(result.changes).toContain(
      "Migrated 2 session delivery queue entries → shared SQLite state",
    );
    const { db } = openOpenClawStateDatabase({ env });
    const rows = db
      .prepare(
        "SELECT queue_name, id, status, channel, target, retry_count FROM delivery_queue_entries ORDER BY queue_name, id",
      )
      .all();
    expect(rows).toEqual([
      {
        queue_name: "outbound",
        id: "outbound-1",
        status: "pending",
        channel: "telegram",
        target: "123",
        retry_count: 2,
      },
      {
        queue_name: "outbound",
        id: "outbound-failed",
        status: "failed",
        channel: "telegram",
        target: "456",
        retry_count: 3,
      },
      {
        queue_name: "session",
        id: "session-1",
        status: "pending",
        channel: null,
        target: null,
        retry_count: 0,
      },
      {
        queue_name: "session",
        id: "session-failed",
        status: "failed",
        channel: null,
        target: null,
        retry_count: 3,
      },
    ]);
    await expectMissingPath(path.join(stateDir, "delivery-queue"));
    await expectMissingPath(path.join(stateDir, "session-delivery-queue"));
  });

  it("keeps legacy delivery queue files when shared SQLite already has a conflicting row", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const queueDir = path.join(stateDir, "delivery-queue");
    await fs.mkdir(path.join(queueDir, "failed"), { recursive: true });
    await fs.writeFile(
      path.join(queueDir, "outbound-1.json"),
      JSON.stringify({
        id: "outbound-1",
        enqueuedAt: 10,
        retryCount: 2,
        channel: "telegram",
        to: "123",
        payloads: [{ text: "hi" }],
      }),
      "utf8",
    );
    await fs.writeFile(path.join(queueDir, "outbound-1.delivered"), '{"id":"done"}\n', "utf8");
    await fs.writeFile(
      path.join(queueDir, "outbound-2.json"),
      JSON.stringify({
        id: "outbound-2",
        enqueuedAt: 11,
        retryCount: 1,
        channel: "telegram",
        to: "456",
        payloads: [{ text: "still pending" }],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(queueDir, "failed", "outbound-failed.json"),
      JSON.stringify({
        id: "outbound-failed",
        enqueuedAt: 12,
        retryCount: 3,
        channel: "telegram",
        to: "789",
        lastError: "nope",
        payloads: [{ text: "failed once" }],
      }),
      "utf8",
    );

    const { db } = openOpenClawStateDatabase({ env });
    db.prepare(
      `
        INSERT INTO delivery_queue_entries (
          queue_name, id, status, channel, target, retry_count, entry_json,
          enqueued_at, updated_at
        ) VALUES (
          'outbound', 'outbound-1', 'pending', 'telegram', '123', 0,
          '{"id":"outbound-1","retryCount":0}', 10, 10
        )
      `,
    ).run();

    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const result = await runLegacyStateMigrations({ detected });

    expect(result.changes).toContain(
      "Migrated 2 outbound delivery queue entries → shared SQLite state",
    );
    expect(result.changes).toContain("Removed 1 outbound delivery queue delivered marker");
    expect(result.warnings).toStrictEqual([
      "Left outbound delivery queue in place because 1 entry already existed in shared state: outbound-1",
    ]);
    await expect(fs.readFile(path.join(queueDir, "outbound-1.json"), "utf8")).resolves.toContain(
      '"retryCount":2',
    );
    await expectMissingPath(path.join(queueDir, "outbound-1.delivered"));
    expect(
      db
        .prepare(
          "SELECT retry_count FROM delivery_queue_entries WHERE queue_name = 'outbound' AND id = 'outbound-1'",
        )
        .get(),
    ).toEqual({ retry_count: 0 });
    expect(
      db
        .prepare(
          "SELECT retry_count FROM delivery_queue_entries WHERE queue_name = 'outbound' AND id = 'outbound-2'",
        )
        .get(),
    ).toEqual({ retry_count: 1 });
    expect(
      db
        .prepare(
          "SELECT retry_count, failed_at FROM delivery_queue_entries WHERE queue_name = 'outbound' AND id = 'outbound-failed'",
        )
        .get(),
    ).toEqual({ retry_count: 3, failed_at: 12 });

    vi.setSystemTime(2_000);
    const rerunDetected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const rerunResult = await runLegacyStateMigrations({ detected: rerunDetected });
    expect(rerunResult.warnings).toStrictEqual([
      "Left outbound delivery queue in place because 1 entry already existed in shared state: outbound-1",
    ]);
  });

  it("preserves a corrupt target session store instead of overwriting it with legacy-only data", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();

    const targetStorePath = path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json");
    // target sessions.json is corrupt (trailing garbage → JSON5.parse fails) and
    // holds a target-only key that has no legacy counterpart.
    const corruptBytes = `${JSON.stringify({
      "agent:worker-1:desk:target-only": { sessionId: "target-only-session", updatedAt: 99 },
    })}\n<<<corrupt trailing garbage>>>`;
    await fs.writeFile(targetStorePath, corruptBytes, "utf8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({
      detected,
      now: () => 1234,
    });

    // The corrupt bytes must survive on disk (parse still fails after migration).
    const afterRaw = await fs.readFile(targetStorePath, "utf8");
    expect(afterRaw).toContain("corrupt trailing garbage");
    expect(afterRaw).toBe(corruptBytes);

    // No SQLite import was committed against the corrupt target.
    expect(result.changes.some((c) => c.startsWith("Imported "))).toBe(false);

    // And no direct-chat migration is reported either: the legacy direct entry was
    // not saved (the target was left untouched), so doctor/startup logs must not
    // claim a session migration happened on this skip path.
    expect(result.changes.some((c) => c.startsWith("Migrated latest direct-chat session"))).toBe(
      false,
    );

    // The user is warned that the target store was left untouched because it is unreadable.
    expect(result.warnings.some((w) => /unreadable|corrupt/i.test(w))).toBe(true);

    // Legacy store is NOT deleted or renamed, so a later explicit doctor --fix
    // can retry the migration from the detector's normal legacy path.
    await expect(
      fs.readFile(path.join(stateDir, "sessions", "sessions.json"), "utf8"),
    ).resolves.toContain("legacy-direct");
    await expect(fs.readFile(path.join(stateDir, "sessions", "trace.jsonl"), "utf8")).resolves.toBe(
      "{}\n",
    );
  });

  it("archives a corrupt target session store before explicit recovery", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();

    const targetStorePath = path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json");
    const corruptBytes = `${JSON.stringify({
      "agent:worker-1:desk:target-only": { sessionId: "target-only-session", updatedAt: 99 },
    })}\n<<<corrupt trailing garbage>>>`;
    await fs.writeFile(targetStorePath, corruptBytes, "utf8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({
      detected,
      now: () => 1234,
      recoverCorruptTargetStore: true,
    });

    const archivedPath = `${targetStorePath}.corrupt-1234`;
    await expect(fs.readFile(archivedPath, "utf8")).resolves.toBe(corruptBytes);

    const recoveredStore = loadSessionStore(targetStorePath, { skipCache: true }) as Record<
      string,
      { sessionId?: string }
    >;
    expect(recoveredStore["agent:worker-1:desk"]?.sessionId).toBe("legacy-direct");
    expect(recoveredStore["agent:worker-1:desk:target-only"]).toBeUndefined();
    expect(result.changes).toContain(`Archived corrupt target sessions store → ${archivedPath}`);
    expect(
      result.changes.some((change) => /^Imported \d+ session metadata row\(s\)/u.test(change)),
    ).toBe(true);
    expect(result.warnings).toStrictEqual([]);
    await expectMissingPath(path.join(stateDir, "sessions", "sessions.json"));
    await expectMissingPath(targetStorePath);
  });
});
