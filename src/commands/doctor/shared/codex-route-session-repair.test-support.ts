import type { SessionEntry } from "../../../config/sessions/types.js";
import type { LegacyCodexModelIdentity } from "./codex-route-model-ref.js";
import type { SessionRouteRepairResult } from "./codex-route-types.js";
import "./codex-route-session-repair.js";

type TestApi = {
  repairCodexSessionStoreRoutes(params: {
    store: Record<string, SessionEntry>;
    now?: number;
    blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
  }): SessionRouteRepairResult;
};

function getTestApi(): TestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.codexRouteSessionRepairTestApi")
  ] as TestApi;
}

export const repairCodexSessionStoreRoutes: TestApi["repairCodexSessionStoreRoutes"] = (params) =>
  getTestApi().repairCodexSessionStoreRoutes(params);
