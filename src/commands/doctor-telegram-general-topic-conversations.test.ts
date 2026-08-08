import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listConversations } from "../config/sessions/conversation-registry.js";
import { patchSessionEntry, upsertSessionEntry } from "../config/sessions/session-accessor.js";
import {
  getSessionKysely,
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveDoctorContributionHealthChecks } from "../flows/doctor-health-contributions.js";
import { runDoctorHealthRepairs } from "../flows/doctor-repair-flow.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";

const CHECK_ID = "core/doctor/telegram-general-topic-conversations";

describe("doctor Telegram General-topic conversation repair", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let cfg: OpenClawConfig;
  let env: NodeJS.ProcessEnv;
  let storePath: string;

  beforeEach(() => {
    const root = tempDirs.make("openclaw-doctor-telegram-topic-");
    storePath = path.join(root, "sessions.json");
    cfg = { session: { store: storePath } };
    env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(root, "missing-openclaw.json"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
    };
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });

  it("merges an upgraded General-topic related binding exactly once", async () => {
    const sessionKey = "agent:main:telegram:group:-1001234567890:topic:1";
    const scope = { agentId: "main", env, sessionKey, storePath };
    const delivery = (to: string) =>
      normalizeSessionDeliveryState({
        context: { channel: "telegram", accountId: "default", to, threadId: "1" },
      });
    await upsertSessionEntry(scope, {
      sessionId: "topic-1-session",
      updatedAt: 100,
      chatType: "group",
      delivery: delivery("telegram:-1001234567890:topic:1"),
    });
    await upsertSessionEntry(scope, {
      sessionId: "topic-1-session",
      updatedAt: 200,
      chatType: "group",
      delivery: delivery("telegram:-1001234567890"),
    });

    const before = listConversations(scope, { channel: "telegram" });
    expect(
      before
        .map(({ target, role }) => ({ target, role }))
        .toSorted((left, right) => left.target.localeCompare(right.target)),
    ).toEqual([
      { target: "telegram:-1001234567890", role: "primary" },
      { target: "telegram:-1001234567890:topic:1", role: "related" },
    ]);
    const legacy = before.find((row) => row.role === "related");
    const canonical = before.find((row) => row.role === "primary");
    expect(legacy).toBeDefined();
    expect(canonical).toBeDefined();

    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteReadScope(scope)));
    const db = getSessionKysely(database.db);
    executeSqliteQuerySync(
      database.db,
      db.insertInto("conversation_deliveries").values({
        operation_id: "legacy-delivery",
        operation_kind: "send",
        conversation_id: legacy!.conversationRef,
        source_session_key: sessionKey,
        message_hash: "hash",
        status: "sent",
        prepared_message_id: null,
        platform_message_id: "message-1",
        queue_id: null,
        rejection_error: null,
        reply_message_id: null,
        reply_to_id: null,
        reply_thread_id: "1",
        reply_text: null,
        reply_timestamp: null,
        created_at: 100,
        updated_at: 100,
      }),
    );
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });

    const check = (await resolveDoctorContributionHealthChecks()).find(
      (candidate) => candidate.id === CHECK_ID,
    );
    expect(check).toBeDefined();
    const runtime = { log() {}, error() {}, exit() {} };
    const repaired = await runDoctorHealthRepairs(
      { mode: "fix", runtime, cfg, env },
      { checks: [check!] },
    );
    expect(repaired.remainingFindings).toEqual([]);
    expect(repaired.changes).toEqual([
      "Merged 1 stale Telegram General-topic conversation identity row(s).",
    ]);

    expect(listConversations(scope, { channel: "telegram" })).toEqual([
      expect.objectContaining({
        conversationRef: canonical!.conversationRef,
        target: "telegram:-1001234567890",
        threadId: "1",
        role: "primary",
        sessionId: "topic-1-session",
      }),
    ]);
    expect(
      executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("conversation_deliveries")
          .select("conversation_id")
          .where("operation_id", "=", "legacy-delivery"),
      ).rows,
    ).toEqual([{ conversation_id: canonical!.conversationRef }]);
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });

    const repeated = await runDoctorHealthRepairs(
      { mode: "fix", runtime, cfg, env },
      { checks: [check!] },
    );
    expect(repeated.findings).toEqual([]);
    expect(repeated.changes).toEqual([]);
    expect(listConversations(scope, { channel: "telegram" })).toHaveLength(1);
  });

  it("canonicalizes a legacy-only current entry before later session writes", async () => {
    const sessionKey = "agent:main:telegram:group:-1002223334444:topic:1";
    const scope = { agentId: "main", env, sessionKey, storePath };
    await upsertSessionEntry(scope, {
      sessionId: "legacy-only-session",
      updatedAt: 100,
      chatType: "group",
      delivery: normalizeSessionDeliveryState({
        context: {
          channel: "telegram",
          accountId: "default",
          to: "telegram:-1002223334444:topic:1",
          threadId: "1",
        },
      }),
    });

    const check = (await resolveDoctorContributionHealthChecks()).find(
      (candidate) => candidate.id === CHECK_ID,
    );
    expect(check).toBeDefined();
    const runtime = { log() {}, error() {}, exit() {} };
    const repaired = await runDoctorHealthRepairs(
      { mode: "fix", runtime, cfg, env },
      { checks: [check!] },
    );
    expect(repaired.remainingFindings).toEqual([]);
    expect(listConversations(scope, { channel: "telegram" })).toEqual([
      expect.objectContaining({
        target: "telegram:-1002223334444",
        threadId: "1",
        role: "primary",
        sessionId: "legacy-only-session",
      }),
    ]);

    await patchSessionEntry(scope, () => ({ displayName: "harmless later write" }));
    expect(listConversations(scope, { channel: "telegram" })).toEqual([
      expect.objectContaining({
        target: "telegram:-1002223334444",
        role: "primary",
        sessionId: "legacy-only-session",
      }),
    ]);
  });
});
