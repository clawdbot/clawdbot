// Session kind classification tests cover ACP child session metadata.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import {
  mockSessionsConfig,
  resetMockSessionsConfig,
  runSessionsJson,
  writeStore,
} from "./sessions.test-helpers.js";

mockSessionsConfig();

const { sessionsCommand } = await import("./sessions.js");

const ACP_SPAWN_CHILD_KEY = "agent:main:acp:7de23a0a-799d-4d63-b1b1-a7de9d4cd840";
const TELEGRAM_GROUP_KEY = "agent:main:telegram:group:-1003967207344:topic:1";

function buildAcpSpawnChildEntry(): SessionEntry {
  return {
    sessionId: "spawn-child-session-id",
    updatedAt: Date.now() - 2 * 60_000,
    spawnedBy: TELEGRAM_GROUP_KEY,
    delivery: normalizeSessionDeliveryState({
      context: {
        channel: "telegram",
        to: "-1003967207344",
        threadId: 323,
      },
    }),
  };
}

describe("sessionsCommand kind classification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-06T00:00:00Z"));
  });

  afterEach(() => {
    resetMockSessionsConfig();
    vi.useRealTimers();
  });

  it("classifies ACP child sessions separately from direct sessions", async () => {
    const store = await writeStore(
      { [ACP_SPAWN_CHILD_KEY]: buildAcpSpawnChildEntry() },
      "sessions-kind-spawn-child",
    );

    const payload = await runSessionsJson<{
      sessions?: Array<{ key: string; kind: string }>;
    }>(sessionsCommand, store);
    const row = payload.sessions?.find((entry) => entry.key === ACP_SPAWN_CHILD_KEY);

    expect(row).toBeDefined();
    expect(row?.kind).toBe("spawn-child");
  });
});
