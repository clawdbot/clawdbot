import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveExistingUsageSessionFile } from "../../infra/session-cost-usage.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";

export const TEST_RUNTIME_CONFIG = {
  agents: {
    list: [{ id: "main", default: true }, { id: "opus" }],
  },
  session: {},
} satisfies OpenClawConfig;

export const BASE_SESSION_USAGE_RANGE = {
  startDate: "2026-02-01",
  endDate: "2026-02-02",
  limit: 10,
} as const;

function requireUsageMockCall(
  mockFn: ReturnType<typeof vi.fn>,
  callIndex = 0,
): ReadonlyArray<unknown> {
  const call = mockFn.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex + 1}`);
  }
  return call;
}

export function getUsageMockArg(
  mockFn: ReturnType<typeof vi.fn>,
  callIndex: number,
  argIndex: number,
) {
  return requireUsageMockCall(mockFn, callIndex)[argIndex];
}

export function mockStoredUsageSession(
  key: string,
  sessionId: string,
  options: {
    agentId?: string;
    config?: OpenClawConfig;
    resolution?: "valid" | "missing";
    storePath?: string;
  } = {},
) {
  const entry = { sessionId, updatedAt: 1_000 };
  const agentId = options.agentId ?? "opus";
  const storePath = options.storePath ?? `/tmp/agents/${agentId}/agent/openclaw-agent.sqlite`;
  vi.mocked(loadGatewaySessionEntryReadOnly).mockReturnValueOnce({
    cfg: options.config ?? TEST_RUNTIME_CONFIG,
    agentId,
    canonicalKey: key,
    entry,
    legacyKey: undefined,
    store: { [key]: entry },
    storeKeys: [key],
    storePath,
  });
  vi.mocked(resolveExistingUsageSessionFile).mockReturnValueOnce(
    options.resolution === "missing" ? undefined : `sqlite:${agentId}:${sessionId}:${storePath}`,
  );
  return entry;
}

export async function withUsageTestState(
  run: (writeSessionFile: (fileName: string) => string) => Promise<void>,
) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-usage-test-"));
  const agentSessionsDir = path.join(stateDir, "agents", "opus", "sessions");
  const writeSessionFile = (fileName: string) => {
    const sessionFile = path.join(agentSessionsDir, fileName);
    fs.writeFileSync(sessionFile, "", "utf-8");
    return sessionFile;
  };

  try {
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      fs.mkdirSync(agentSessionsDir, { recursive: true });
      await run(writeSessionFile);
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}
