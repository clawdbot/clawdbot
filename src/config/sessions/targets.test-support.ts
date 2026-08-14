import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import type { OpenClawConfig } from "../config.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { resolveAllAgentSessionStoreTargetsSync } from "./targets.js";

export const EXPLICIT_MAIN_CONFIG: OpenClawConfig = {
  agents: { list: [{ id: "main", default: true }] },
};

export async function resolveRealStorePath(sessionsDir: string): Promise<string> {
  return path.resolve(path.join(sessionsDir, "sessions.json"));
}

export async function createAgentSessionStores(
  root: string,
  agentIds: string[],
): Promise<Record<string, string>> {
  const storePaths: Record<string, string> = {};
  for (const agentId of agentIds) {
    const sessionsDir = path.join(root, "agents", agentId, "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    await fs.mkdir(sessionsDir, { recursive: true });
    await replaceSessionEntry(
      { storePath, sessionKey: "main" },
      { sessionId: "sid", updatedAt: Date.now() },
    );
    storePaths[agentId] = await resolveRealStorePath(sessionsDir);
  }
  return storePaths;
}

export function createCustomRootCfg(customRoot: string, defaultAgentId = "ops"): OpenClawConfig {
  return {
    session: { store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json") },
    agents: { list: [{ id: defaultAgentId, default: true }] },
  };
}

export function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  return items.filter(predicate).length;
}

export async function resolveTargetsForCustomRoot(home: string, agentIds: string[]) {
  const customRoot = path.join(home, "custom-state");
  const storePaths = await createAgentSessionStores(customRoot, agentIds);
  const targets = resolveAllAgentSessionStoreTargetsSync(createCustomRootCfg(customRoot), {
    env: process.env,
  });
  return { storePaths, targets };
}

export function expectTargetsToContainStores(
  targets: Array<{ agentId: string; storePath: string }>,
  stores: Record<string, string>,
): void {
  for (const [agentId, storePath] of Object.entries(stores)) {
    expect(
      targets.some((target) => target.agentId === agentId && target.storePath === storePath),
    ).toBe(true);
  }
}
