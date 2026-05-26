import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  legacyOAuthSidecarInternalTestUtils,
  legacyOAuthSidecarTestUtils,
  loadLegacyOAuthSidecarMaterial,
} from "./legacy-oauth-sidecar.js";

const states: OpenClawTestState[] = [];

function setPlatform(value: NodeJS.Platform): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  return () => {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  };
}

async function writeLegacySidecarThatNeedsKeychain(): Promise<{
  state: OpenClawTestState;
  ref: { source: "openclaw-credentials"; provider: "openai-codex"; id: string };
  profileId: string;
}> {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-legacy-oauth-keychain-warn-",
    env: {
      OPENCLAW_AGENT_DIR: undefined,
      OPENCLAW_AUTH_PROFILE_SECRET_KEY: undefined,
    },
  });
  states.push(state);
  const profileId = "openai-codex:default";
  const ref = {
    source: "openclaw-credentials" as const,
    provider: "openai-codex" as const,
    id: "0123456789abcdef0123456789abcdef",
  };
  await state.writeJson(`credentials/auth-profiles/${ref.id}.json`, {
    version: 1,
    profileId,
    provider: "openai-codex",
    encrypted: legacyOAuthSidecarTestUtils.encryptLegacyOAuthMaterial({
      ref,
      profileId,
      provider: "openai-codex",
      seed: "only-in-keychain",
      material: { access: "a", refresh: "b", idToken: "c" },
    }),
  });
  return { state, ref, profileId };
}

afterEach(async () => {
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
  legacyOAuthSidecarInternalTestUtils.resetKeychainOnlyMigrationHint();
});

describe("loadLegacyOAuthSidecarMaterial keychain-only headless warning", () => {
  let restorePlatform: () => void;
  let warnSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    restorePlatform = setPlatform("darwin");
    setLoggerOverride({ level: "warn", consoleLevel: "warn" });
    warnSpy = vi.fn();
    loggingState.rawConsole = {
      log: vi.fn(),
      info: vi.fn(),
      warn: warnSpy as unknown as typeof console.warn,
      error: vi.fn(),
    };
  });

  afterEach(() => {
    restorePlatform();
    loggingState.rawConsole = null;
    setLoggerOverride(null);
    resetLogger();
  });

  function envWithoutVitestSignals(state: OpenClawTestState): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...state.env };
    delete env.VITEST;
    delete env.VITEST_WORKER_ID;
    return env;
  }

  it("emits a single doctor-pointer warning when only Keychain can decrypt and prompts are disabled", async () => {
    const { state, ref, profileId } = await writeLegacySidecarThatNeedsKeychain();
    const env = envWithoutVitestSignals(state);

    const firstAttempt = loadLegacyOAuthSidecarMaterial({
      ref,
      profileId,
      provider: "openai-codex",
      allowKeychainPrompt: false,
      env,
    });
    expect(firstAttempt).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [firstMessage] = warnSpy.mock.calls[0] as [unknown];
    expect(String(firstMessage)).toContain("openclaw doctor --fix");
    expect(String(firstMessage)).toContain("macOS Keychain");

    const secondAttempt = loadLegacyOAuthSidecarMaterial({
      ref,
      profileId,
      provider: "openai-codex",
      allowKeychainPrompt: false,
      env,
    });
    expect(secondAttempt).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("does not emit the doctor-pointer warning on non-darwin platforms", async () => {
    restorePlatform();
    restorePlatform = setPlatform("linux");
    const { state, ref, profileId } = await writeLegacySidecarThatNeedsKeychain();
    const env = envWithoutVitestSignals(state);

    const attempt = loadLegacyOAuthSidecarMaterial({
      ref,
      profileId,
      provider: "openai-codex",
      allowKeychainPrompt: false,
      env,
    });
    expect(attempt).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
