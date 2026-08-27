import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { NodeWorkerSupervisorTransport } from "../gateway/node-registry-private.js";
import { createNodeWorkerLaunchAdapter } from "../gateway/worker-environments/node-launch-adapter.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../infra/node-runner-inventory.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  parseNodeWorkerLaunchInput,
  projectNodeWorkerSupervisorReceipt,
} from "./node-worker-supervisor-contract.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  TEST_WORKER_ENDPOINT,
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseForTest);

describe("node worker admission re-arm journal", () => {
  it("retains each child's reason and replays the same attempts after supervisor restart", async () => {
    const fixture = writeNodeWorkerFixture(tempDirs.make("node-admission-journal-"));
    let supervisor = createNodeWorkerSupervisor(fixture);
    const launchIds = new Set<string>();
    const transport: NodeWorkerSupervisorTransport = {
      isCurrent: () => true,
      hasCurrentRunner: () => true,
      listCurrentNodes: async () => [
        {
          nodeId: "node-1",
          connId: "conn-1",
          pairingIdentity: "identity-1",
          pairingGeneration: "generation-1",
          clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
          clientMode: GATEWAY_CLIENT_MODES.NODE,
          protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
          workerHost: { enabled: true, capacity: { total: 1, available: 1 } },
          commands: [],
        },
      ],
      invoke: async (request) => {
        let receipt;
        if (request.command === "worker.launch.v1") {
          const input = parseNodeWorkerLaunchInput(JSON.stringify(request.params));
          launchIds.add(input.launchId);
          request.onDispatchReady?.("invoke-1");
          receipt = await supervisor.launch(input, TEST_WORKER_ENDPOINT);
        } else if (request.command === "worker.status.v1") {
          receipt = await supervisor.status((request.params as { launchId: string }).launchId);
        } else {
          throw new Error("unexpected cancellation");
        }
        return {
          ok: true,
          payloadJSON: JSON.stringify(receipt ? projectNodeWorkerSupervisorReceipt(receipt) : null),
        };
      },
    };
    const request = {
      deviceId: "node-1",
      input: testWorkerLaunchInput(fixture.workspaceDir, "admission-launch", "admission-rearm"),
      isDispatchAuthorized: () => true,
      isCancellationAuthorized: () => true,
      timeoutMs: 10_000,
    };
    const createAdapter = () =>
      createNodeWorkerLaunchAdapter({ getTransport: () => transport, pollIntervalMs: 10 });
    try {
      const completed = await createAdapter().launch(request);
      expect(completed).toMatchObject({
        state: "completed",
        resultJson: JSON.stringify({
          status: "completed",
          transcriptLeafId: "leaf-1",
          transcriptNextSeq: 2,
        }),
      });
      expect(launchIds.size).toBe(2);
      const first = await supervisor.status(request.input.launchId);
      expect(JSON.parse(first?.resultJson ?? "null")).toEqual({
        status: "not-started",
        reason: "admission-deadline",
        errorText: "gateway unreachable [REDACTED]",
      });
      expect(first?.completedAtMs).not.toBeNull();
      const marker = path.join(fixture.workspaceDir, "admission-attempt");
      expect(fs.readFileSync(marker, "utf8")).toBe(completed.launchId);
      await supervisor.close();
      supervisor = createNodeWorkerSupervisor(fixture);
      expect(await createAdapter().launch(request)).toEqual(completed);
      expect(fs.readFileSync(marker, "utf8")).toBe(completed.launchId);
      expect(launchIds.size).toBe(2);
    } finally {
      await supervisor.close();
    }
  });
});
