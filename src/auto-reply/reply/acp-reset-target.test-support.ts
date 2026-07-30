import type { resolveConfiguredBindingRecord } from "../../channels/plugins/binding-registry.js";
import type { listAcpBindings } from "../../config/bindings.js";
import type { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import "./acp-reset-target.js";

type AcpResetTargetTestDeps = {
  getSessionBindingService: typeof getSessionBindingService;
  listAcpBindings: typeof listAcpBindings;
  resolveConfiguredBindingRecord: typeof resolveConfiguredBindingRecord;
};

type AcpResetTargetTestApi = {
  setDepsForTest(overrides?: Partial<AcpResetTargetTestDeps>): void;
};

function getTestApi(): AcpResetTargetTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.acpResetTargetTestApi")
  ];
  if (!api) {
    throw new Error("ACP reset target test API is unavailable");
  }
  return api as AcpResetTargetTestApi;
}

export const testing = {
  setDepsForTest(overrides?: Partial<AcpResetTargetTestDeps>): void {
    getTestApi().setDepsForTest(overrides);
  },
};
