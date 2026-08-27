// Covers Matrix native DM identity across route resolution, ownership, and persistence.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matrixPlugin } from "../../../extensions/matrix/channel-plugin-api.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  normalizeSessionDeliveryState,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.shared.js";
import {
  bindOutboundSessionEntry,
  resolveOutboundSessionRoute,
  selectAuthoritativeOutboundTargetSessionRoute,
} from "./outbound-session.js";
import {
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
} from "./session-binding-service.js";

const matrixUserId = "@alice:example.org";
const matrixRoomId = "!dm:example.org";

describe("Matrix outbound native DM routes", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let cfg: OpenClawConfig;
  let storePath: string;

  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", source: "test", plugin: matrixPlugin }]),
    );
    registerSessionBindingAdapter({
      channel: "matrix",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: () => null,
    });
    storePath = path.join(tempDirs.make("matrix-native-route-"), "sessions.json");
    cfg = { session: { store: storePath } };
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    closeOpenClawAgentDatabasesForTest();
  });

  async function resolveMatrixUserRoute() {
    return await resolveOutboundSessionRoute({
      cfg,
      channel: "matrix",
      agentId: "main",
      accountId: "default",
      target: matrixUserId,
      resolvedTarget: {
        to: matrixUserId,
        kind: "user",
        source: "normalized",
        resolutionSource: "normalized",
      },
    });
  }

  it("selects the authoritative default per-user DM after restoring its native room", async () => {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:main", storePath },
      {
        sessionId: "matrix-dm-session",
        updatedAt: 1,
        chatType: "direct",
        delivery: normalizeSessionDeliveryState({
          context: { channel: "matrix", accountId: "default", to: `room:${matrixRoomId}` },
          origin: {
            provider: "matrix",
            accountId: "default",
            chatType: "direct",
            from: `matrix:${matrixUserId}`,
            to: `room:${matrixRoomId}`,
            nativeChannelId: matrixRoomId,
            nativeDirectUserId: matrixUserId,
          },
        }),
      },
    );

    const route = await resolveMatrixUserRoute();
    expect(route).toMatchObject({
      sessionKey: "agent:main:main",
      nativeChannelId: matrixRoomId,
      peer: { kind: "direct", id: matrixUserId },
    });

    const selected = selectAuthoritativeOutboundTargetSessionRoute({
      cfg,
      sourceAgentId: "main",
      channel: "matrix",
      accountId: "default",
      route,
    });
    expect(selected).toMatchObject({
      agentId: "main",
      route: { sessionKey: "agent:main:main", nativeChannelId: matrixRoomId },
    });
    expect(selected?.isCurrent()).toBe(true);
  });

  it("fails closed before a default per-user DM has a persisted native room", async () => {
    const route = await resolveMatrixUserRoute();

    expect(route?.nativeChannelId).toBeUndefined();
    expect(
      selectAuthoritativeOutboundTargetSessionRoute({
        cfg,
        sourceAgentId: "main",
        channel: "matrix",
        accountId: "default",
        route,
      }),
    ).toBeNull();
  });

  it("persists an explicit native room for a direct outbound route", async () => {
    await bindOutboundSessionEntry({
      cfg,
      agentId: "main",
      channel: "matrix",
      accountId: "default",
      route: {
        sessionKey: "agent:main:main",
        baseSessionKey: "agent:main:main",
        nativeChannelId: matrixRoomId,
        peer: { kind: "direct", id: matrixUserId },
        chatType: "direct",
        from: `matrix:${matrixUserId}`,
        to: `room:${matrixUserId}`,
      },
    });

    const persisted = loadExactSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath,
    });
    expect(sessionDeliveryOrigin(persisted?.entry)).toMatchObject({
      nativeChannelId: matrixRoomId,
      nativeDirectUserId: matrixUserId,
    });
  });
});
