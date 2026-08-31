// Imessage tests cover state migrations plugin behavior.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { buildLegacyMigrationPreview } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspaceSync,
  type TempWorkspaceSync,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stateMigrations } from "../doctor-contract-api.js";
import { resolveIMessageCatchupCursorKey } from "./state-contract.js";
import { detectIMessageLegacyStateMigrations } from "./state-migrations.js";

describe("detectIMessageLegacyStateMigrations", () => {
  let stateWorkspace: TempWorkspaceSync;

  beforeEach(() => {
    stateWorkspace = tempWorkspaceSync({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-imsg-migration-",
    });
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    resetPluginStateStoreForTests();
    stateWorkspace.cleanup();
    vi.doUnmock("./runtime.js");
    vi.doUnmock("openclaw/plugin-sdk/routing");
    vi.resetModules();
  });

  it.each(["runtime", "routing"])(
    "detects absent and unconfigured legacy state without loading %s",
    async (boundary) => {
      vi.resetModules();
      if (boundary === "runtime") {
        vi.doMock("./runtime.js", () => {
          throw new Error("doctor detection must not materialize channel runtime");
        });
      } else {
        vi.doMock("openclaw/plugin-sdk/routing", () => {
          throw new Error("account lookup must not materialize message routing");
        });
      }
      const { detectIMessageLegacyStateMigrations: detect } = await import("./state-migrations.js");
      const params = { cfg: {}, env: {}, stateDir: stateWorkspace.dir };
      expect(await detect(params)).toEqual([]);
      expect(fs.readdirSync(stateWorkspace.dir)).toEqual([]);
      const imsgDir = path.join(stateWorkspace.dir, "imessage");
      fs.mkdirSync(imsgDir);
      fs.writeFileSync(
        path.join(imsgDir, "reply-cache.jsonl"),
        JSON.stringify({
          accountId: "default",
          messageId: "legacy",
          shortId: "7",
          timestamp: Date.now(),
        }),
      );
      const plans = await detect(params);
      expect(plans.map((plan) => plan.label)).toEqual([
        "iMessage reply short-id counter",
        "iMessage reply short-id cache",
      ]);
      const counter = plans[0];
      if (counter?.kind !== "plugin-state-import") {
        throw new Error("expected counter import");
      }
      expect(await counter.readEntries()).toEqual([
        { key: "short-id-counter", value: { counter: 7 } },
      ]);
    },
  );

  function legacyCatchupFilename(accountId: string): string {
    return `${accountId}__${createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 12)}.json`;
  }

  it("imports reply, echo, and catchup sidecars into plugin state plans", async () => {
    const stateDir = stateWorkspace.dir;
    const imsgDir = path.join(stateDir, "imessage");
    fs.mkdirSync(path.join(imsgDir, "catchup"), { recursive: true });
    fs.writeFileSync(
      path.join(imsgDir, "reply-cache.jsonl"),
      JSON.stringify({
        accountId: "default",
        messageId: "guid-1",
        shortId: "1",
        timestamp: Date.now(),
        chatIdentifier: "+15551234567",
      }) + "\n",
    );
    fs.writeFileSync(
      path.join(imsgDir, "sent-echoes.jsonl"),
      JSON.stringify({
        scope: "default:imessage:+15551234567",
        text: "hello",
        timestamp: Date.now(),
      }) + "\n",
    );
    fs.writeFileSync(
      path.join(imsgDir, "catchup", "default__37a8eec1ce19.json"),
      JSON.stringify({
        lastSeenMs: 1_700_000_000_000,
        lastSeenRowid: 42,
        updatedAt: 1_700_000_000_123,
      }),
    );
    const orphanPath = path.join(imsgDir, "catchup", "removed__123456789abc.json");
    fs.writeFileSync(orphanPath, JSON.stringify({ lastSeenMs: 1, lastSeenRowid: 2 }));

    const plans = await detectIMessageLegacyStateMigrations({
      cfg: { channels: { imessage: { enabled: true } } } as never,
      env: {},
      stateDir,
    });

    expect(plans.map((plan) => plan.label)).toEqual([
      "iMessage catchup cursor",
      "iMessage orphan catchup cursor",
      "iMessage reply short-id counter",
      "iMessage reply short-id cache",
      "iMessage sent-echo dedupe cache",
    ]);
    for (const plan of plans) {
      expect(plan.kind).toBe("plugin-state-import");
      if (plan.kind !== "plugin-state-import") {
        throw new Error("expected plugin-state-import plan");
      }
      expect(plan.pluginId).toBe("imessage");
      if (plan.label !== "iMessage reply short-id counter") {
        expect(plan.cleanupSource).toBe("rename");
      }
      if (
        plan.label === "iMessage reply short-id cache" ||
        plan.label === "iMessage sent-echo dedupe cache"
      ) {
        expect(plan.cleanupWhenEmpty).toBe(true);
      }
      const entries = await plan.readEntries();
      expect(entries).toHaveLength(plan.label === "iMessage orphan catchup cursor" ? 0 : 1);
    }

    expect(
      plans.map((plan) => ({
        kind: plan.kind,
        label: plan.label,
        sourcePath: plan.sourcePath,
        targetPath: plan.targetPath,
        namespace: plan.kind === "plugin-state-import" ? plan.namespace : null,
      })),
    ).toEqual([
      {
        kind: "plugin-state-import",
        label: "iMessage catchup cursor",
        sourcePath: path.join(imsgDir, "catchup", "default__37a8eec1ce19.json"),
        targetPath: "plugin state:imessage.catchup-cursors",
        namespace: "imessage.catchup-cursors",
      },
      {
        kind: "plugin-state-import",
        label: "iMessage orphan catchup cursor",
        sourcePath: orphanPath,
        targetPath: "plugin state:imessage.catchup-cursors",
        namespace: "imessage.catchup-cursors",
      },
      {
        kind: "plugin-state-import",
        label: "iMessage reply short-id counter",
        sourcePath: path.join(imsgDir, "reply-cache.jsonl"),
        targetPath: "plugin state:imessage.reply-cache-counter",
        namespace: "imessage.reply-cache-counter",
      },
      {
        kind: "plugin-state-import",
        label: "iMessage reply short-id cache",
        sourcePath: path.join(imsgDir, "reply-cache.jsonl"),
        targetPath: "plugin state:imessage.reply-cache",
        namespace: "imessage.reply-cache",
      },
      {
        kind: "plugin-state-import",
        label: "iMessage sent-echo dedupe cache",
        sourcePath: path.join(imsgDir, "sent-echoes.jsonl"),
        targetPath: "plugin state:imessage.sent-echoes",
        namespace: "imessage.sent-echoes",
      },
    ]);
    await expect(
      stateMigrations[0]?.detectLegacyState({
        config: { channels: { imessage: { enabled: true } } } as never,
        env: {},
        stateDir,
        oauthDir: path.join(stateDir, "credentials"),
        context: { openPluginStateKeyedStore: () => ({}) } as never,
      }),
    ).resolves.toEqual({ preview: plans.map(buildLegacyMigrationPreview) });

    const catchupPlan = plans.find((plan) => plan.label === "iMessage catchup cursor");
    expect(catchupPlan?.kind).toBe("plugin-state-import");
    if (!catchupPlan || catchupPlan.kind !== "plugin-state-import") {
      throw new Error("expected catchup plugin-state-import plan");
    }
    const [catchupEntry] = await catchupPlan.readEntries();
    expect(
      await catchupPlan.shouldReplaceExistingEntry?.({
        key: catchupEntry?.key ?? "",
        existingValue: { lastSeenMs: 1_600_000_000_000, lastSeenRowid: 10, updatedAt: 0 },
        incomingValue: catchupEntry?.value,
      }),
    ).toBe(true);
    expect(
      await catchupPlan.shouldReplaceExistingEntry?.({
        key: catchupEntry?.key ?? "",
        existingValue: { lastSeenMs: 1_800_000_000_000, lastSeenRowid: 99, updatedAt: 0 },
        incomingValue: catchupEntry?.value,
      }),
    ).toBe(false);

    const counterPlan = plans.find((plan) => plan.label === "iMessage reply short-id counter");
    expect(counterPlan?.kind).toBe("plugin-state-import");
    if (!counterPlan || counterPlan.kind !== "plugin-state-import") {
      throw new Error("expected reply counter plugin-state-import plan");
    }
    expect(
      await counterPlan.shouldReplaceExistingEntry?.({
        key: "short-id-counter",
        existingValue: { counter: 0 },
        incomingValue: { counter: 1 },
      }),
    ).toBe(true);
    expect(
      await counterPlan.shouldReplaceExistingEntry?.({
        key: "short-id-counter",
        existingValue: { counter: 2 },
        incomingValue: { counter: 1 },
      }),
    ).toBe(false);

    const migration = stateMigrations[0];
    if (!migration) {
      throw new Error("expected iMessage migration");
    }
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const input = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "credentials"),
      context: {
        openPluginStateKeyedStore: <T>(
          options: Parameters<typeof createPluginStateKeyedStoreForTests>[1],
        ) => createPluginStateKeyedStoreForTests<T>("imessage", { ...options, env }),
      },
    };
    const migrated = await migration.migrateLegacyState(input);
    expect(migrated.warnings).toEqual([]);
    expect(migrated.changes.length).toBeGreaterThan(0);
    for (const plan of plans) {
      if (plan.kind !== "plugin-state-import") {
        throw new Error("expected plugin-state import");
      }
      const entries = await createPluginStateKeyedStoreForTests("imessage", {
        namespace: plan.namespace,
        maxEntries: plan.maxEntries,
        env,
      }).entries();
      expect(entries).toHaveLength(1);
      if (plan.label === "iMessage reply short-id counter") {
        expect(entries[0]?.value).toEqual({ counter: 1 });
      }
      if (plan.cleanupSource === "rename") {
        expect(fs.existsSync(plan.sourcePath)).toBe(false);
        expect(fs.existsSync(`${plan.sourcePath}.migrated`)).toBe(true);
      }
    }
    expect(await migration.detectLegacyState(input)).toBeNull();
    expect(await migration.migrateLegacyState(input)).toEqual({ changes: [], warnings: [] });
  });

  it("leaves unreadable reply-cache sidecars for a later migration attempt", async () => {
    const stateDir = stateWorkspace.dir;
    const imsgDir = path.join(stateDir, "imessage");
    fs.mkdirSync(imsgDir, { recursive: true });
    const sourcePath = path.join(imsgDir, "reply-cache.jsonl");
    fs.writeFileSync(sourcePath, "\n");

    const plans = await detectIMessageLegacyStateMigrations({
      cfg: { channels: { imessage: { enabled: true } } } as never,
      env: {},
      stateDir,
    });
    const replyPlan = plans.find((plan) => plan.label === "iMessage reply short-id cache");
    expect(replyPlan?.kind).toBe("plugin-state-import");
    if (!replyPlan || replyPlan.kind !== "plugin-state-import") {
      throw new Error("expected reply cache plugin-state-import plan");
    }
    fs.rmSync(sourcePath);

    expect(() => replyPlan.readEntries()).toThrow("Failed reading");
  });

  it("keeps the latest live reply-cache row for duplicate message ids", async () => {
    const stateDir = stateWorkspace.dir;
    const imsgDir = path.join(stateDir, "imessage");
    fs.mkdirSync(imsgDir, { recursive: true });
    const now = Date.now();
    fs.writeFileSync(
      path.join(imsgDir, "reply-cache.jsonl"),
      [
        JSON.stringify({
          accountId: "default",
          messageId: "guid-dup",
          shortId: "1",
          timestamp: now - 2_000,
        }),
        JSON.stringify({
          accountId: "default",
          messageId: "guid-dup",
          shortId: "7",
          timestamp: now - 1_000,
        }),
      ].join("\n"),
    );

    const plans = await detectIMessageLegacyStateMigrations({
      cfg: { channels: { imessage: { enabled: true } } } as never,
      env: {},
      stateDir,
    });
    const replyPlan = plans.find((plan) => plan.label === "iMessage reply short-id cache");
    const counterPlan = plans.find((plan) => plan.label === "iMessage reply short-id counter");
    if (!replyPlan || replyPlan.kind !== "plugin-state-import") {
      throw new Error("expected reply cache plugin-state-import plan");
    }
    if (!counterPlan || counterPlan.kind !== "plugin-state-import") {
      throw new Error("expected reply counter plugin-state-import plan");
    }

    const replyEntries = await replyPlan.readEntries();
    const counterEntries = await counterPlan.readEntries();
    expect(replyEntries).toHaveLength(1);
    const replyEntry = replyEntries[0];
    if (!replyEntry) {
      throw new Error("expected reply cache entry");
    }
    expect((replyEntry.value as { shortId?: string }).shortId).toBe("7");
    expect(counterEntries[0]?.value).toEqual({ counter: 7 });
  });

  it("archives catchup cursor files that do not match configured accounts", async () => {
    const stateDir = stateWorkspace.dir;
    const catchupDir = path.join(stateDir, "imessage", "catchup");
    fs.mkdirSync(catchupDir, { recursive: true });
    const sourcePath = path.join(catchupDir, "removed-account__123456789abc.json");
    fs.writeFileSync(sourcePath, JSON.stringify({ lastSeenMs: 1, lastSeenRowid: 2 }));

    const plans = await detectIMessageLegacyStateMigrations({
      cfg: { channels: { imessage: { enabled: true } } } as never,
      env: {},
      stateDir,
    });

    const orphanPlan = plans.find((plan) => plan.label === "iMessage orphan catchup cursor");
    expect(orphanPlan).toMatchObject({
      kind: "plugin-state-import",
      sourcePath,
      cleanupSource: "rename",
      cleanupWhenEmpty: true,
    });
    if (!orphanPlan || orphanPlan.kind !== "plugin-state-import") {
      throw new Error("expected orphan catchup plugin-state-import plan");
    }
    expect(await orphanPlan.readEntries()).toEqual([]);
  });

  it("normalizes configured account ids before importing catchup cursor files", async () => {
    const stateDir = stateWorkspace.dir;
    const catchupDir = path.join(stateDir, "imessage", "catchup");
    fs.mkdirSync(catchupDir, { recursive: true });
    const sourcePath = path.join(catchupDir, legacyCatchupFilename("work"));
    fs.writeFileSync(sourcePath, JSON.stringify({ lastSeenMs: 1, lastSeenRowid: 2 }));

    const plans = await detectIMessageLegacyStateMigrations({
      cfg: {
        channels: {
          imessage: {
            enabled: true,
            accounts: {
              Work: { cliPath: "imsg-work" },
            },
          },
        },
      } as never,
      env: {},
      stateDir,
    });

    expect(plans.map((plan) => plan.label)).toEqual(["iMessage catchup cursor"]);
    const [plan] = plans;
    expect(plan?.kind).toBe("plugin-state-import");
    if (!plan || plan.kind !== "plugin-state-import") {
      throw new Error("expected catchup plugin-state-import plan");
    }
    expect(plan.sourcePath).toBe(sourcePath);
    const [entry] = await plan.readEntries();
    expect(entry?.key).toBe(resolveIMessageCatchupCursorKey("work"));
  });

  it("caps imported catchup retry maps for plugin-state value limits", async () => {
    const stateDir = stateWorkspace.dir;
    const catchupDir = path.join(stateDir, "imessage", "catchup");
    fs.mkdirSync(catchupDir, { recursive: true });
    fs.writeFileSync(
      path.join(catchupDir, "default__37a8eec1ce19.json"),
      JSON.stringify({
        lastSeenMs: 1,
        lastSeenRowid: 2,
        failureRetries: Object.fromEntries(
          Array.from({ length: 800 }, (_, index) => [
            `GUID-${index}-${"x".repeat(120)}`,
            index + 1,
          ]),
        ),
      }),
    );

    const plans = await detectIMessageLegacyStateMigrations({
      cfg: { channels: { imessage: { enabled: true } } } as never,
      env: {},
      stateDir,
    });
    const catchupPlan = plans.find((plan) => plan.label === "iMessage catchup cursor");
    if (!catchupPlan || catchupPlan.kind !== "plugin-state-import") {
      throw new Error("expected catchup plugin-state-import plan");
    }

    const [entry] = await catchupPlan.readEntries();
    expect(new TextEncoder().encode(JSON.stringify(entry?.value)).byteLength).toBeLessThanOrEqual(
      65_536,
    );
  });
});
