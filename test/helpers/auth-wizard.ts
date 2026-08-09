// Auth wizard helpers drive authentication wizard flows in tests.
import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import type { RuntimeEnv } from "../../src/runtime.js";
import { makeTempWorkspace } from "../../src/test-helpers/workspace.js";
import { captureEnv } from "../../src/test-utils/env.js";
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
export async function setupAuthTestEnv(
  prefix = "openclaw-auth-",
  options?: { agentSubdir?: string },
): Promise<{
  stateDir: string;
  agentDir: string;
}> {
  const stateDir = await makeTempWorkspace(prefix);
  const agentDir = path.join(stateDir, options?.agentSubdir ?? "agent");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_AGENT_DIR = agentDir;
  await fs.mkdir(agentDir, { recursive: true });
  return { stateDir, agentDir };
}

type AuthTestLifecycle = {
  setStateDir: (stateDir: string) => void;
  cleanup: () => Promise<void>;
};

/** Capture env and track one state dir for cleanup. */
export function createAuthTestLifecycle(envKeys: string[]): AuthTestLifecycle {
  const envSnapshot = captureEnv(envKeys);
  let stateDir: string | null = null;
  return {
    setStateDir(nextStateDir: string) {
      stateDir = nextStateDir;
    },
    async cleanup() {
      if (stateDir) {
        await fs.rm(stateDir, { recursive: true, force: true });
        stateDir = null;
      }
      envSnapshot.restore();
    },
  };
}

/** Resolve the auth profile JSON path for an agent directory. */
function authProfilePathForAgent(agentDir: string): string {
  return path.join(agentDir, "auth-profiles.json");
}

/** Read and parse auth profiles for an agent directory. */
export async function readAuthProfilesForAgent<T>(agentDir: string): Promise<T> {
  const raw = await fs.readFile(authProfilePathForAgent(agentDir), "utf8");
  return JSON.parse(raw) as T;
}
