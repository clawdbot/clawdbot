import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import type { RuntimeEnv } from "../../src/runtime.js";
import { makeTempWorkspace } from "../../src/test-helpers/workspace.js";
import { captureEnv } from "../../src/test-utils/env.js";
import type { WizardPrompter } from "../../src/wizard/prompts.js";

const noopAsync = async () => {};
const noop = () => {};

export function createExitThrowingRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }),
  };
}

export function createWizardPrompter(
  overrides: Partial<WizardPrompter>,
  options?: { defaultSelect?: string },
): WizardPrompter {
  return {
    intro: vi.fn(noopAsync),
    outro: vi.fn(noopAsync),
    note: vi.fn(noopAsync),
    select: vi.fn(async () => (options?.defaultSelect ?? "") as never),
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => "") as unknown as WizardPrompter["text"],
    confirm: vi.fn(async () => false),
    progress: vi.fn(() => ({ update: noop, stop: noop })),
    ...overrides,
  };
}

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
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await fs.mkdir(agentDir, { recursive: true });
  return { stateDir, agentDir };
}

type AuthTestLifecycle = {
  setStateDir: (stateDir: string) => void;
  cleanup: () => Promise<void>;
};

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

export function requireOpenClawAgentDir(): string {
  const agentDir = process.env.OPENCLAW_AGENT_DIR;
  if (!agentDir) {
    throw new Error("OPENCLAW_AGENT_DIR not set");
  }
  return agentDir;
}

function authProfilePathForAgent(agentDir: string): string {
  return path.join(agentDir, "auth-profiles.json");
}

export async function readAuthProfilesForAgent<T>(agentDir: string): Promise<T> {
  const raw = await fs.readFile(authProfilePathForAgent(agentDir), "utf8");
  return JSON.parse(raw) as T;
}
