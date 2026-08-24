// Auth wizard helpers drive authentication wizard flows in tests.
import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { loadPersistedAuthProfileStore } from "../../src/agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../src/agents/auth-profiles/runtime-snapshots.js";
import type { RuntimeEnv } from "../../src/runtime.js";
import { captureEnv } from "../../src/test-utils/env.js";
import { createOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import type { WizardPrompter } from "../../src/wizard/prompts.js";
import { createWizardPrompter as createBaseWizardPrompter } from "./wizard-prompter.js";

// Shared auth wizard test helpers for runtime/env setup.

/** Create a RuntimeEnv whose exit method throws for assertions. */
export function createExitThrowingRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }),
  };
}

/** Create a WizardPrompter with default mock answers and caller overrides. */
export function createWizardPrompter(
  overrides: Partial<WizardPrompter>,
  options?: { defaultSelect?: string },
): WizardPrompter {
  return createBaseWizardPrompter(overrides, { defaultSelect: options?.defaultSelect ?? "" });
}

/** Create isolated auth state and agent directories for auth tests. */
type AuthTestEnv = {
  stateDir: string;
  agentDir: string;
  cleanup: () => Promise<void>;
};

export async function setupAuthTestEnv(
  prefix = "openclaw-auth-",
  options?: { agentSubdir?: string },
): Promise<AuthTestEnv> {
  clearRuntimeAuthProfileStoreSnapshots();
  const state = await createOpenClawTestState({ prefix, layout: "state-only" });
  const agentDir = path.join(state.stateDir, options?.agentSubdir ?? "agent");
  process.env.OPENCLAW_AGENT_DIR = agentDir;
  await fs.mkdir(agentDir, { recursive: true });
  return { stateDir: state.stateDir, agentDir, cleanup: state.cleanup };
}

type AuthTestLifecycle = {
  track: (env: AuthTestEnv) => void;
  cleanup: () => Promise<void>;
};

/** Capture env and track isolated OpenClaw state fixtures for cleanup. */
export function createAuthTestLifecycle(envKeys: string[]): AuthTestLifecycle {
  const envSnapshot = captureEnv(envKeys);
  const cleanups: Array<() => Promise<void>> = [];
  return {
    track(env) {
      cleanups.push(env.cleanup);
    },
    async cleanup() {
      clearRuntimeAuthProfileStoreSnapshots();
      for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
      }
      envSnapshot.restore();
    },
  };
}

/** Read auth profiles from the real SQLite-backed persistence owner. */
export async function readAuthProfilesForAgent<T>(agentDir: string): Promise<T> {
  const store = loadPersistedAuthProfileStore(agentDir);
  if (!store) {
    throw new Error(`Expected SQLite auth profile store for ${agentDir}`);
  }
  return store as T;
}
