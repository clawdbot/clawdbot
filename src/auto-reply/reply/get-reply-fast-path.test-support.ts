import { afterEach, beforeEach } from "vitest";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { markReplyConfigRuntimeMode } from "./reply-config-runtime-mode.js";

export function emptyAliasIndex(): ModelAliasIndex {
  return { byAlias: new Map(), byKey: new Map() };
}

export function registerFastReplySessionStore(): () => string {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({
      label: "get-reply-fast-path",
      applyEnv: false,
    });
  });
  afterEach(async () => {
    await state.cleanup();
  });
  return () => state.statePath("sessions", "sessions.json");
}

export function markCompleteReplyConfig<T extends OpenClawConfig>(
  config: T,
  options?: { runtimeMode?: "fast" | "full" },
): T {
  return markReplyConfigRuntimeMode(config, options?.runtimeMode ?? "fast");
}

export function withFastReplyConfig<T extends OpenClawConfig>(config: T): T {
  return markCompleteReplyConfig(config);
}
