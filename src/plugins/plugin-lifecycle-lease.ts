import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  OpenClawStateLeaseError,
  withOpenClawStateLease,
  type OpenClawStateLeaseContext,
} from "../state/openclaw-state-lease.js";
import { clearLoadInstalledPluginIndexInstallRecordsCache } from "./installed-plugin-index-record-cache.js";

const PLUGIN_LIFECYCLE_LEASE_SCOPE = "core:plugin-lifecycle";
const PLUGIN_LIFECYCLE_LEASE_KEY = "global";
const DEFAULT_PLUGIN_LIFECYCLE_LEASE_MS = 5 * 60_000;
const DEFAULT_PLUGIN_LIFECYCLE_WAIT_MS = 10 * 60_000;

type ActivePluginLifecycleLease = {
  databasePath: string;
  lease: OpenClawStateLeaseContext;
};

type PluginLifecycleLeaseOptions = Pick<
  OpenClawStateDatabaseOptions,
  "env" | "path" | "database"
> & {
  signal?: AbortSignal;
  leaseMs?: number;
  waitMs?: number;
};

const activePluginLifecycleLease = new AsyncLocalStorage<ActivePluginLifecycleLease>();

function resolveLifecycleLeaseEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const requested = env ?? process.env;
  if (!process.env.VITEST || requested.VITEST || requested.OPENCLAW_STATE_DIR) {
    return requested;
  }
  return {
    ...requested,
    VITEST: process.env.VITEST,
    VITEST_WORKER_ID: process.env.VITEST_WORKER_ID,
    VITEST_POOL_ID: process.env.VITEST_POOL_ID,
  };
}

/** Serialize plugin artifact, install-index, and config mutations across processes. */
export async function withPluginLifecycleLease<T>(
  options: PluginLifecycleLeaseOptions,
  run: (lease: OpenClawStateLeaseContext) => Promise<T>,
): Promise<T> {
  const env = resolveLifecycleLeaseEnv(options.env);
  const databasePath = path.resolve(
    options.database?.path ?? options.path ?? resolveOpenClawStateSqlitePath(env),
  );
  const active = activePluginLifecycleLease.getStore();
  if (active) {
    if (active.databasePath !== databasePath) {
      throw new OpenClawStateLeaseError(
        "nested plugin lifecycle lease cannot switch the shared state database",
        { code: "OPENCLAW_STATE_LEASE_INVALID_INPUT" },
      );
    }
    options.signal?.throwIfAborted();
    active.lease.assertOwned();
    return await run(active.lease);
  }

  return await withOpenClawStateLease(
    {
      scope: PLUGIN_LIFECYCLE_LEASE_SCOPE,
      key: PLUGIN_LIFECYCLE_LEASE_KEY,
      database: {
        scope: "shared",
        options: {
          env,
          ...(options.path ? { path: options.path } : {}),
          ...(options.database ? { database: options.database } : {}),
        },
      },
      leaseMs: options.leaseMs ?? DEFAULT_PLUGIN_LIFECYCLE_LEASE_MS,
      waitMs: options.waitMs ?? DEFAULT_PLUGIN_LIFECYCLE_WAIT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
      leaseLabel: "plugin lifecycle lease",
      operationLabel: "plugins.lifecycle.lease",
    },
    async (lease) => {
      // Another process may have committed while this process waited for ownership.
      clearLoadInstalledPluginIndexInstallRecordsCache();
      return await activePluginLifecycleLease.run(
        { databasePath, lease },
        async () => await run(lease),
      );
    },
  );
}
