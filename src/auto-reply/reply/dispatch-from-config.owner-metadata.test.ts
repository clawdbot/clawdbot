import { afterEach, expect, it, vi } from "vitest";
import { buildAcpDatabaseSessionKey } from "../../acp/runtime/session-meta-keys.js";
import * as sessionMeta from "../../acp/runtime/session-meta.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { gatherDispatchRequest } from "./dispatch-from-config.gather.js";
import { prepareDispatchDelivery } from "./dispatch-from-config.prepare-delivery.js";
import * as runtimeLoaders from "./dispatch-from-config.runtime-loaders.js";
import * as dispatchRuntime from "./dispatch-from-config.runtime.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

let state: OpenClawTestState | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await state?.cleanup();
});

it.each([
  "canonical",
  "read-recovery",
  "lifecycle-change",
  "parent-change",
  "replacement-parent",
  "replacement-detached",
  "owner-error",
] as const)("keeps explicit-owner ACP metadata current across gather: %s", async (scenario) => {
  state = await createOpenClawTestState({ label: "dispatch-owner-metadata" });
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { main: {}, work: {} },
      defaults: { workspace: state.workspaceDir },
    },
    plugins: { enabled: false },
    session: { scope: "global" },
  };
  await state.writeConfig(cfg);
  const scope = {
    agentId: "work",
    sessionKey: "global",
    storePath: dispatchRuntime.resolveSessionStorePathCore(undefined, { agentId: "work" }),
  };
  const entry = {
    sessionId: "child",
    lifecycleRevision: "before-gather",
    updatedAt: 1,
    spawnedBy: "agent:work:parent",
  };
  replaceSessionEntrySync(scope, entry);
  const meta = {
    backend: "acpx",
    agent: "synthetic",
    runtimeSessionName: "canonical-child",
    mode: "persistent",
    state: "idle",
    lastActivityAt: 1,
  } as const;
  sessionMeta.writeAcpSessionMetaForMigration({
    sessionKey: buildAcpDatabaseSessionKey("global", "work"),
    lifecycleRevision: entry.lifecycleRevision,
    meta,
  });
  if (scenario === "read-recovery") {
    vi.spyOn(dispatchRuntime, "loadSessionStoreEntry").mockImplementationOnce(() => {
      throw new Error("synthetic initial read failure");
    });
  }
  const loadRuntimePlugins = runtimeLoaders.loadRuntimePlugins;
  vi.spyOn(runtimeLoaders, "loadRuntimePlugins").mockImplementationOnce(async () => {
    await Promise.resolve();
    if (scenario === "lifecycle-change") {
      replaceSessionEntrySync(scope, { ...entry, lifecycleRevision: "after-gather" });
    }
    if (scenario === "replacement-parent" || scenario === "replacement-detached") {
      replaceSessionEntrySync(scope, {
        ...entry,
        sessionId: "replacement-child",
        lifecycleRevision: "after-gather",
        spawnedBy: scenario === "replacement-parent" ? "agent:work:new-parent" : undefined,
      });
      sessionMeta.writeAcpSessionMetaForMigration({
        sessionKey: buildAcpDatabaseSessionKey("global", "work"),
        lifecycleRevision: "after-gather",
        meta: { ...meta, runtimeSessionName: "replacement-child" },
      });
    }
    if (scenario === "owner-error") {
      cfg.session = { ...cfg.session, store: scope.storePath };
      cfg.agents!.defaults = { ...cfg.agents!.defaults, sessionStore: { agentId: "main" } };
    }
    if (scenario === "parent-change") {
      replaceSessionEntrySync(scope, { ...entry, spawnedBy: undefined });
    }
    return await loadRuntimePlugins();
  });
  const dispatcher = createReplyDispatcher({ deliver: async () => undefined });
  try {
    const gathered = await gatherDispatchRequest(
      {
        cfg,
        ctx: {
          AgentId: "work",
          SessionKey: "global",
          Body: "hello",
          Provider: "webchat",
          Surface: "webchat",
          ChatType: "direct",
          CommandAuthorized: false,
        },
        dispatcher,
      },
      undefined,
    );
    expect(gathered.status).toBe("ready");
    if (gathered.status !== "ready") {
      throw new Error("dispatch gather did not prepare the turn");
    }
    // Canonical ACP metadata is deliberately absent from the captured session row.
    expect(gathered.state.sessionStoreEntry.entry?.acp).toBeUndefined();
    expect(gathered.state.sessionStoreEntry.entry?.lifecycleRevision).toBe(
      scenario === "read-recovery" ? undefined : "before-gather",
    );
    if (scenario === "owner-error") {
      await expect(prepareDispatchDelivery(gathered.state)).rejects.toThrow("fixed-store");
      return;
    }
    const prepared = await prepareDispatchDelivery(gathered.state);
    expect(prepared.state.suppressAcpChildUserDelivery).toBe(
      scenario === "canonical" || scenario === "read-recovery" || scenario === "replacement-parent",
    );
  } finally {
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
  }
});
