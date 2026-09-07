import { readFile } from "node:fs/promises";
import { definePluginEntry, WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "qa-prepared-pool",
  name: "Prepared pool wire fixture",
  description: "Exercises automatic reserves with isolated local node leases.",
  register(api) {
    const { endpoint, token } = api.pluginConfig;
    const call = async (action, body, signal) => {
      const response = await fetch(`${endpoint}/${action}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        throw new Error(`Prepared pool fixture ${action} failed: ${await response.text()}`);
      }
      return await response.json();
    };
    const leaseId = (operationId) => `qa-prepared:${operationId}`;
    api.registerWorkerProvider({
      id: "qa-prepared-pool",
      supportedExecutionModes: ["worker-turn"],
      requiresNodeEnrollment: true,
      supportsProjectPreparation: () => true,
      resolvePreparedIdleTimeoutMs: () => 300_000,
      resolvePreparationTarget: () => ({
        machineClass: "fixture",
        platform: process.platform,
        arch: process.arch,
      }),
      resolveAllocation: async (_profile, operationId) => ({
        leaseId: leaseId(operationId),
        sharedHost: false,
      }),
      async provision(_profile, operationId, options) {
        if (!options?.project?.preparation || !options.beginNodeEnrollment) {
          throw new WorkerProviderError("Fixture requires the canonical prepared-node contract");
        }
        const lease = leaseId(operationId);
        try {
          const { commandTimeoutMs } = await call("allocate", { leaseId: lease }, options.signal);
          const prepared = await options.project.prepare({
            runScript: async (script, signal) =>
              (await call("script", { leaseId: lease, script }, signal)).stdout,
            runScriptWithBudget: async (createScript, signal) =>
              (
                await call(
                  "script",
                  { leaseId: lease, script: createScript(commandTimeoutMs) },
                  signal,
                )
              ).stdout,
            upload: async (localPath, remotePath, signal) => {
              const bytes = await readFile(localPath, { signal });
              await call(
                "upload",
                { leaseId: lease, remotePath, base64: bytes.toString("base64") },
                signal,
              );
            },
          });
          const enrollment = await options.beginNodeEnrollment();
          const enrolled = await call(
            "enroll",
            {
              leaseId: lease,
              ...(enrollment.mode === "connect"
                ? { setupCode: enrollment.setupCode }
                : { deviceId: enrollment.deviceId }),
              prepared: prepared.preparedWorkspace,
            },
            enrollment.signal,
          );
          const deviceId = await enrollment.waitForDeviceId();
          if (deviceId !== enrolled.deviceId) {
            throw new Error("Enrollment did not bind the exact fixture node");
          }
          return { leaseId: lease, sharedHost: false, node: { deviceId } };
        } catch (error) {
          try {
            await call("destroy", { leaseId: lease });
          } catch (cleanupError) {
            throw WorkerProviderError.cleanupIndeterminate(lease, error, cleanupError);
          }
          throw error;
        }
      },
      inspect: async ({ leaseId }) => await call("inspect", { leaseId }),
      destroy: async ({ leaseId }) => {
        await call("destroy", { leaseId });
      },
    });
  },
});
