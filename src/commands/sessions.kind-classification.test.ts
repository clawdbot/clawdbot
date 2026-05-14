import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  mockSessionsConfig,
  resetMockSessionsConfig,
  runSessionsJson,
  writeStore,
} from "./sessions.test-helpers.js";

/**
 * Catalog #19 — `kind` misclassified as `"direct"` for ACP spawn-child sessions.
 *
 * Bug summary: `classifySessionKey` (defined twice — `src/commands/sessions.ts:136-152`
 * and `src/commands/status.summary.runtime.ts:129-145`) classifies a session
 * based ONLY on the key shape (`:group:` / `:channel:` substrings) plus
 * `entry.chatType`. It ignores `entry.spawnedBy` and `entry.deliveryContext`,
 * so ACP spawn-child sessions (e.g., `agent:copilot:acp:<uuid>` with
 * `spawnedBy: "agent:main:telegram:group:..."` and
 * `deliveryContext: { channel: "telegram", to: <groupId>, threadId: <topic> }`)
 * are misclassified as `kind: "direct"` even though they were spawned from a
 * group/topic-bound parent.
 *
 * Available kinds today:
 *   "global" | "unknown" | "cron" | "group" | "direct"
 *
 * The fix shape proposed in the catalog is to add a new `"spawn-child"` kind
 * (or, alternatively, fall through to the parent's classification — but the
 * catalog calls out `"spawn-child"` as the cleanest minimal fix).
 *
 * NOTE ON DUPLICATION: the same logic lives in two places —
 *   - `src/commands/sessions.ts:136-152`        (called by `sessionsCommand`,
 *     the path under test here)
 *   - `src/commands/status.summary.runtime.ts:129-145`
 * The eventual fix MUST update both, or extract a shared helper.
 *
 * NOTE ON SURFACE: `classifySessionKey` is private to each file (not exported),
 * so this test drives the classification through the exposed seam:
 * `sessionsCommand --json` and inspects the `kind` field of each session row
 * (mirroring `src/commands/sessions.test.ts` and `sessions.acp-runtime-metadata.test.ts`).
 */

mockSessionsConfig();

const { sessionsCommand } = await import("./sessions.js");

type SessionRowKind = "global" | "unknown" | "cron" | "group" | "direct" | "spawn-child";

type SessionsJsonPayload = {
  sessions?: Array<{
    key: string;
    kind: SessionRowKind;
  }>;
};

const ACP_SPAWN_CHILD_KEY = "agent:copilot:acp:7de23a0a-799d-4d63-b1b1-a7de9d4cd840";
const ACP_DM_KEY = "agent:copilot:acp:86b7b5af-3773-4a56-b244-069d6c5d3db9";
const TELEGRAM_GROUP_KEY = "agent:main:telegram:group:-1003967207344:topic:1";

/**
 * SessionEntry shape mirroring the deployed-container record described in
 * the catalog (a copilot ACP session spawned by a telegram supergroup parent).
 * Only the fields the classifier and the JSON emit path care about are set;
 * everything else stays unset / default.
 */
function buildAcpSpawnChildEntry(): SessionEntry {
  return {
    sessionId: "spawn-child-session-id",
    updatedAt: Date.now() - 2 * 60_000,
    spawnedBy: TELEGRAM_GROUP_KEY,
    deliveryContext: {
      channel: "telegram",
      to: "-1003967207344",
      threadId: 323,
    },
    // No chatType — ACP spawn-child entries don't carry one. The classifier
    // must infer "this came from a group" from spawnedBy / deliveryContext.
  };
}

/**
 * Plain DM-driven ACP session: same key shape (`agent:copilot:acp:<uuid>`)
 * but no `spawnedBy` and a direct delivery context. Today's classifier
 * correctly reports `"direct"` for this; that behavior should be preserved
 * after the fix.
 */
function buildAcpDirectEntry(): SessionEntry {
  return {
    sessionId: "dm-session-id",
    updatedAt: Date.now() - 5 * 60_000,
    deliveryContext: {
      channel: "telegram",
      to: "+15555550123",
    },
  };
}

/**
 * Group session with a key that explicitly embeds `:group:` — the
 * classifier's existing key-shape branch picks this up correctly today
 * and reports `"group"`.
 */
function buildTelegramGroupEntry(): SessionEntry {
  return {
    sessionId: "group-session-id",
    updatedAt: Date.now() - 10 * 60_000,
    chatType: "group",
  };
}

describe("sessionsCommand kind classification (catalog #19)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-06T00:00:00Z"));
  });

  afterEach(() => {
    resetMockSessionsConfig();
    vi.useRealTimers();
  });

  it("RED: ACP spawn-child session must NOT be classified as 'direct'", async () => {
    // RED today. The classifier ignores `spawnedBy` and `deliveryContext`,
    // so an ACP key with no `:group:` substring and no `chatType` falls
    // through to `"direct"`. Operators see this session in
    // `openclaw sessions --json` as `kind: "direct"` even though it was
    // plainly spawned from a group/topic. See `src/commands/sessions.ts:136-152`.
    const store = writeStore(
      { [ACP_SPAWN_CHILD_KEY]: buildAcpSpawnChildEntry() },
      "sessions-kind-spawn-child-red",
    );

    const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
    const row = payload.sessions?.find((entry) => entry.key === ACP_SPAWN_CHILD_KEY);

    expect(
      row,
      `Expected sessionsCommand --json to include a row for ${ACP_SPAWN_CHILD_KEY}; got none.`,
    ).toBeDefined();
    expect(
      row?.kind,
      `ACP spawn-child session ${ACP_SPAWN_CHILD_KEY} is misclassified: kind="${row?.kind}". ` +
        `It carries spawnedBy="${TELEGRAM_GROUP_KEY}" and deliveryContext.channel="telegram", ` +
        `which clearly mark it as a non-direct origin. The classifier at ` +
        `src/commands/sessions.ts:136-152 ignores these fields and returns "direct".`,
    ).not.toBe("direct");
  });

  it("RED (fix-shape): ACP spawn-child session should resolve to 'spawn-child'", async () => {
    // RED today; flips GREEN once the proposed fix lands.
    //
    // The catalog's recommended fix introduces a new `"spawn-child"` kind
    // checked BEFORE the key-shape branch so spawn-child ACP sessions take
    // precedence over the fallback `"direct"` classification.
    //
    // If the fix author chooses a different label (e.g., `"acp-child"`) or
    // a different shape (e.g., fall through to the parent's classification
    // and report `"group"`), update this assertion to match. The structural
    // point is that `entry.spawnedBy` / `entry.deliveryContext` MUST drive
    // the classification for ACP children.
    const store = writeStore(
      { [ACP_SPAWN_CHILD_KEY]: buildAcpSpawnChildEntry() },
      "sessions-kind-spawn-child-fix-shape",
    );

    const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
    const row = payload.sessions?.find((entry) => entry.key === ACP_SPAWN_CHILD_KEY);

    expect(row).toBeDefined();
    expect(
      row?.kind,
      `ACP spawn-child session ${ACP_SPAWN_CHILD_KEY} should classify as "spawn-child" ` +
        `(or whichever non-direct label the fix author chooses). Got "${row?.kind}". ` +
        `Fix locations: src/commands/sessions.ts:136-152 AND ` +
        `src/commands/status.summary.runtime.ts:129-145 (the same logic is duplicated; ` +
        `extract to a shared helper or update both).`,
    ).toBe("spawn-child");
  });

  it("GREEN control: non-spawn-child ACP DM session resolves to 'direct'", async () => {
    // GREEN today. An ACP-keyed session WITHOUT `spawnedBy` and with a
    // direct delivery context (or none) correctly resolves to `"direct"`.
    // This control proves the test infrastructure exercises the real
    // classification path; if it accidentally regressed to a different
    // value, that would indicate the test harness was broken.
    const store = writeStore(
      { [ACP_DM_KEY]: buildAcpDirectEntry() },
      "sessions-kind-acp-direct-control",
    );

    const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
    const row = payload.sessions?.find((entry) => entry.key === ACP_DM_KEY);

    expect(row).toBeDefined();
    expect(row?.kind).toBe("direct");
  });

  it("GREEN control: telegram group key with chatType='group' resolves to 'group'", async () => {
    // GREEN today. The classifier's key-shape branch (`:group:` substring)
    // and the `chatType === "group"` branch both fire for this entry,
    // yielding `"group"`. This control proves the existing happy-path
    // classification still works and is not silently broken by the test
    // harness.
    const store = writeStore(
      { [TELEGRAM_GROUP_KEY]: buildTelegramGroupEntry() },
      "sessions-kind-group-control",
    );

    const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
    const row = payload.sessions?.find((entry) => entry.key === TELEGRAM_GROUP_KEY);

    expect(row).toBeDefined();
    expect(row?.kind).toBe("group");
  });
});
