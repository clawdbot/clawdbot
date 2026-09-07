import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { sha256Hex } from "../infra/crypto-digest.js";
import { withFileLock } from "../infra/file-lock.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import { resolveLaunchAgentGuiDomain } from "./launchd-runtime.js";
import { resolveTaskName } from "./schtasks-layout.js";
import type { GatewayServiceEnv } from "./service-types.js";
import { resolveSystemdUnitPath } from "./systemd-service-files.js";

type Scope = { active: boolean; pending: Set<Promise<unknown>> };
const scopes = new AsyncLocalStorage<Map<string, Scope>>();

/** Serialize native effects and original-file capture using the shipped file-lock
 * owner. This lock does not attest a stopped gateway or replace native identity
 * inspection; stopped-state capture additionally holds the gateway coordinator.
 */
export async function withGatewayServiceOperationLock<T>(
  env: GatewayServiceEnv,
  operation: (assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  const identity =
    process.platform === "darwin"
      ? `launchd:${resolveLaunchAgentGuiDomain()}/${resolveLaunchAgentLabel(env)}`
      : process.platform === "win32"
        ? `schtasks:${resolveTaskName(env).toLowerCase()}`
        : `systemd:${resolveSystemdUnitPath(env)}`;
  const file = path.join(
    resolvePreferredOpenClawTmpDir(),
    `service-lifecycle-${sha256Hex(identity)}`,
  );
  const inherited = scopes.getStore();
  const parent = inherited?.get(file);
  const assertScope = (scope: Scope) => {
    if (!scope.active) {
      throw new Error("Native service operation ownership has closed.");
    }
  };
  if (parent?.active) {
    let active = true;
    const work = Promise.resolve().then(() =>
      operation(() => {
        assertScope(parent);
        if (!active) {
          throw new Error("Native service operation ownership has closed.");
        }
      }),
    );
    parent.pending.add(work);
    try {
      return await work;
    } finally {
      active = false;
      parent.pending.delete(work);
    }
  }
  const scope: Scope = { active: false, pending: new Set() };
  const next = new Map(inherited);
  next.set(file, scope);
  return await withFileLock(
    file,
    {
      retries: { retries: 120, factor: 1.1, minTimeout: 25, maxTimeout: 250 },
      stale: 30_000,
      staleRecovery: "fail-closed",
    },
    async () =>
      scopes.run(next, async () => {
        scope.active = true;
        const [outcome] = await Promise.allSettled([
          Promise.resolve().then(() => operation(() => assertScope(scope))),
        ]);
        const failures: unknown[] = [];
        // Only admitted work still pending when the outer callback settles is
        // ours to join. Preserve its failures rather than reporting a completed
        // native interval after a detached effect failed.
        while (scope.pending.size) {
          for (const result of await Promise.allSettled(scope.pending)) {
            if (result.status === "rejected") {
              failures.push(result.reason);
            }
          }
        }
        // Close admission atomically with the final empty-pending observation.
        scope.active = false;
        if (failures.length) {
          throw new AggregateError(
            outcome.status === "rejected" ? [outcome.reason, ...failures] : failures,
            "Native service operation did not settle successfully.",
          );
        }
        if (outcome.status === "rejected") {
          throw outcome.reason instanceof Error
            ? outcome.reason
            : new Error("Native service operation failed.", { cause: outcome.reason });
        }
        return outcome.value;
      }),
  );
}
