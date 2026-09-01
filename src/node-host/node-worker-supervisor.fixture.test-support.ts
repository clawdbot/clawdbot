import { expect, vi } from "vitest";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import { writeNodeWorkerFixture } from "./node-worker-supervisor.test-support.js";

export function createNodeWorkerSupervisorFixture(
  root: string,
  options: Parameters<typeof createNodeWorkerSupervisor>[0] = {},
) {
  const fixture = writeNodeWorkerFixture(root);
  const { bundleRoot, env } = fixture;
  return { ...fixture, supervisor: createNodeWorkerSupervisor({ bundleRoot, env, ...options }) };
}

export async function waitForNodeWorkerTerminal(
  supervisor: ReturnType<typeof createNodeWorkerSupervisor>,
  launchId: string,
) {
  await vi.waitFor(
    async () => {
      expect((await supervisor.status(launchId))?.state).not.toMatch(/^(?:pending|running)$/u);
    },
    { timeout: 5_000 },
  );
  const receipt = await supervisor.status(launchId);
  if (!receipt) {
    throw new Error(`missing launch receipt ${launchId}`);
  }
  return receipt;
}
