import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";

const MCP_LIFECYCLE_LEASE_SCOPE = "core:claw-mcp-lifecycle";
const MCP_LIFECYCLE_LEASE_MS = 5 * 60_000;
const MCP_LIFECYCLE_WAIT_MS = 10 * 60_000;

type McpLifecycleLeaseOptions = Pick<OpenClawStateDatabaseOptions, "env" | "path" | "database"> & {
  signal?: AbortSignal;
};

/** Serialize ownership decisions and global config mutations for one MCP server. */
export async function withMcpLifecycleLease<T>(
  name: string,
  options: McpLifecycleLeaseOptions,
  run: (assertOwned: () => void) => Promise<T>,
): Promise<T> {
  return await withOpenClawStateLease(
    {
      scope: MCP_LIFECYCLE_LEASE_SCOPE,
      key: name.trim(),
      database: {
        scope: "shared",
        options: {
          ...(options.env ? { env: options.env } : {}),
          ...(options.path ? { path: options.path } : {}),
          ...(options.database ? { database: options.database } : {}),
        },
      },
      leaseMs: MCP_LIFECYCLE_LEASE_MS,
      waitMs: MCP_LIFECYCLE_WAIT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
      leaseLabel: "Claw MCP lifecycle lease",
      operationLabel: "claws.mcp.lifecycle.lease",
    },
    async (lease) => {
      lease.assertOwned();
      const result = await run(() => lease.assertOwned());
      lease.assertOwned();
      return result;
    },
  );
}

export const withClawMcpLifecycleLease = withMcpLifecycleLease;
