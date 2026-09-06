/** Gateway-backed archive and delete commands for stored sessions. */
import type {
  PreservedSessionWorktree,
  SessionRow,
  SessionsDeleteResult,
  WorktreePreservationReason,
} from "../../packages/gateway-protocol/src/index.js";
import { resolveConfiguredAgentId } from "../agents/agent-scope-config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "../cli/failure-output.js";
import { callGatewayFromCliWithTransport } from "../cli/gateway-rpc.js";
import { getRuntimeConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { SESSION_ARCHIVE_REQUEST_TIMEOUT_MS } from "../shared/session-archive-timeout.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";

type SessionsLifecycleCliOptions = {
  keys: string[];
  agent?: string;
  dryRun?: boolean;
  yes?: boolean;
  timeout?: string;
  url?: string;
  token?: string;
  password?: string;
  json?: boolean;
};

type SessionsLifecycleOperation = "archive" | "delete";

type SessionsLifecycleStatus =
  | "archived"
  | "already_archived"
  | "deleted"
  | "would_archive"
  | "would_delete"
  | "not_found"
  | "failed";

type SessionsLifecycleResult = {
  key: string;
  ok: boolean;
  status: SessionsLifecycleStatus;
  error?: string;
  archived?: string[];
  worktreePreserved?: PreservedSessionWorktree;
};

type SessionsListRow = Pick<SessionRow, "key" | "sessionId" | "archived" | "isMain">;

type SessionsListResult = {
  sessions?: SessionsListRow[];
  hasMore?: boolean;
  nextOffset?: number | null;
};

type SessionsPatchResult = {
  ok?: boolean;
  key?: string;
  entry?: { archivedAt?: number };
};

type SessionsLifecycleRpcOptions = Parameters<typeof callGatewayFromCliWithTransport>[1];

// Keep each read bounded while exhausting pagination when an invalid key must
// be distinguished from a session outside the first Gateway list page.
const SESSION_TARGET_PAGE_SIZE = 200;

function resolveLifecycleAgentId(rawAgent: string | undefined): string | undefined {
  const requested = rawAgent?.trim();
  if (rawAgent !== undefined && !requested) {
    throw new Error("--agent must not be blank");
  }
  return requested ? resolveConfiguredAgentId(getRuntimeConfig(), requested) : undefined;
}

function listHint(agent?: string): string {
  const agentFlag = agent ? ` --agent ${agent}` : "";
  return formatCliCommand(`openclaw sessions list${agentFlag} --json`);
}

function notFoundResult(key: string, agent?: string): SessionsLifecycleResult {
  return {
    key,
    ok: false,
    status: "not_found",
    error: `Session not found. Run ${listHint(agent)} to choose a valid key.`,
  };
}

const WORKTREE_PRESERVATION_REASON_COPY = {
  "owner-mismatch": "registered to another owner",
  busy: "still in use by a live run or another cleanup",
  "foreign-lock": "Git reports a lock owned outside OpenClaw",
  "snapshot-failed": "OpenClaw could not create a safety snapshot",
  "cleanup-failed": "cleanup did not finish normally",
} as const satisfies Record<WorktreePreservationReason, string>;

async function listRequestedSessions(
  keys: readonly string[],
  agent: string | undefined,
  rpcOptions: SessionsLifecycleRpcOptions,
): Promise<Map<string, SessionsListRow>> {
  const wanted = new Set(keys);
  const found = new Map<string, SessionsListRow>();
  let offset = 0;

  while (wanted.size > found.size) {
    const page = (await callGatewayFromCliWithTransport(
      "sessions.list",
      rpcOptions,
      {
        limit: SESSION_TARGET_PAGE_SIZE,
        ...(offset > 0 ? { offset } : {}),
        archived: "all",
        includeGlobal: true,
        includeUnknown: true,
        configuredAgentsOnly: true,
        ...(agent ? { agentId: agent } : {}),
      },
      { defaultTimeoutMs: 30_000 },
    )) as SessionsListResult;
    if (!page || !Array.isArray(page.sessions)) {
      throw new Error("Gateway returned an invalid sessions.list response.");
    }
    for (const row of page.sessions) {
      if (wanted.has(row.key) && !found.has(row.key)) {
        found.set(row.key, row);
      }
    }
    if (found.size === wanted.size || page.hasMore !== true) {
      break;
    }
    const nextOffset = page.nextOffset;
    if (typeof nextOffset !== "number" || nextOffset <= offset) {
      throw new Error("Gateway returned invalid sessions.list pagination.");
    }
    offset = nextOffset;
  }

  return found;
}

function outputLifecycleResults(
  operation: SessionsLifecycleOperation,
  dryRun: boolean,
  results: SessionsLifecycleResult[],
  runtime: RuntimeEnv,
  json: boolean,
): void {
  const ok = results.every((result) => result.ok);
  if (json) {
    writeRuntimeJson(
      runtime,
      ok
        ? { ok, operation, dryRun, results }
        : {
            ...formatCliJsonFailure(
              `Session ${operation} did not complete for every requested key.`,
            ),
            operation,
            dryRun,
            results,
          },
    );
  } else {
    for (const result of results) {
      switch (result.status) {
        case "archived":
          runtime.log(`Archived session ${result.key}.`);
          break;
        case "already_archived":
          runtime.log(`Session ${result.key} is already archived.`);
          break;
        case "deleted":
          runtime.log(`Deleted session ${result.key}.`);
          for (const archived of result.archived ?? []) {
            runtime.log(`Archived transcript: ${archived}`);
          }
          if (result.worktreePreserved) {
            const preserved = result.worktreePreserved;
            runtime.error(
              `Worktree ${preserved.branch} at ${preserved.path} needs attention: ${WORKTREE_PRESERVATION_REASON_COPY[preserved.reason]}. Inspect it with ${formatCliCommand("openclaw worktrees list")}.`,
            );
          }
          break;
        case "would_archive":
          runtime.log(`[dry-run] archive session ${result.key}`);
          break;
        case "would_delete":
          runtime.log(`[dry-run] delete session ${result.key} and its live transcript state`);
          break;
        case "not_found":
        case "failed":
          runtime.error(`${operation} ${result.key}: ${result.error ?? "Unknown failure."}`);
          break;
      }
    }
  }
  if (!ok) {
    runtime.exit(1);
  }
}

async function runSessionsLifecycleCommand(
  operation: SessionsLifecycleOperation,
  opts: SessionsLifecycleCliOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const keys = opts.keys.map((key) => key.trim());
  const rpcOptions: SessionsLifecycleRpcOptions = {
    url: opts.url,
    token: opts.token,
    password: opts.password,
    timeout: opts.timeout,
    json: opts.json,
  };
  let sessions: Map<string, SessionsListRow>;
  let agent: string | undefined;
  try {
    // The not-found hint points at `sessions list --agent <id>`, which rejects an unconfigured id
    // locally. Validating here keeps that suggestion runnable instead of handing back a dead end.
    agent = resolveLifecycleAgentId(opts.agent);
    sessions = await listRequestedSessions(keys.filter(Boolean), agent, rpcOptions);
  } catch (error) {
    rethrowExpectedCliError(error);
    const message = formatErrorMessage(error);
    outputLifecycleResults(
      operation,
      Boolean(opts.dryRun),
      keys.map((key) => ({ key, ok: false, status: "failed", error: message })),
      runtime,
      Boolean(opts.json),
    );
    return;
  }

  const results = keys.map((key): SessionsLifecycleResult | undefined =>
    key && sessions.has(key) ? undefined : notFoundResult(key, agent),
  );
  const listedTargets = keys.flatMap((key, index) => {
    const session = sessions.get(key);
    return session ? [{ index, session }] : [];
  });
  const validTargets = listedTargets.filter(({ index, session }) => {
    const needsMutation = !opts.dryRun && !(operation === "archive" && session.archived === true);
    if (!needsMutation || session.sessionId) {
      return true;
    }
    results[index] = {
      key: session.key,
      ok: false,
      status: "failed",
      error: "Session has no durable identity; lifecycle mutation was not attempted.",
    };
    return false;
  });

  if (operation === "delete" && !opts.dryRun && !opts.yes && validTargets.length > 0) {
    if (opts.json || !process.stdin.isTTY) {
      const error = "Deletion requires confirmation. Pass --yes to delete non-interactively.";
      for (const { index, session } of validTargets) {
        results[index] = { key: session.key, ok: false, status: "failed", error };
      }
      outputLifecycleResults(
        operation,
        false,
        results.filter((result) => result !== undefined),
        runtime,
        Boolean(opts.json),
      );
      return;
    }
    const confirmed = await createClackPrompter().confirm({
      message: `Delete ${validTargets.length} session${validTargets.length === 1 ? "" : "s"} and remove live transcript state?`,
      initialValue: false,
    });
    if (!confirmed) {
      runtime.log("Cancelled.");
      return;
    }
  }

  for (const { index, session } of validTargets) {
    if (operation === "archive" && session.archived === true) {
      results[index] = { key: session.key, ok: true, status: "already_archived" };
      continue;
    }
    try {
      if (opts.dryRun) {
        // Global classification does not encode selected-agent deletion eligibility.
        if (session.isMain === true && session.key !== "global") {
          throw new Error(
            operation === "archive"
              ? "Cannot archive an agent's main session."
              : `Cannot delete the main session (${session.key}).`,
          );
        }
        results[index] = {
          key: session.key,
          ok: true,
          status: operation === "archive" ? "would_archive" : "would_delete",
        };
        continue;
      }
      if (operation === "archive") {
        const response = (await callGatewayFromCliWithTransport(
          "sessions.patch",
          rpcOptions,
          {
            key: session.key,
            ...(agent ? { agentId: agent } : {}),
            ...(session.sessionId ? { expectedSessionId: session.sessionId } : {}),
            archived: true,
          },
          { defaultTimeoutMs: SESSION_ARCHIVE_REQUEST_TIMEOUT_MS },
        )) as SessionsPatchResult;
        if (response?.ok !== true || response.entry?.archivedAt === undefined) {
          throw new Error("Gateway did not confirm that the session was archived.");
        }
        results[index] = { key: response.key ?? session.key, ok: true, status: "archived" };
      } else {
        const response = (await callGatewayFromCliWithTransport(
          "sessions.delete",
          rpcOptions,
          {
            key: session.key,
            ...(agent ? { agentId: agent } : {}),
            ...(session.sessionId ? { expectedSessionId: session.sessionId } : {}),
            deleteTranscript: true,
            ...(session.archived === true ? { archivedOnly: true } : {}),
          },
          { defaultTimeoutMs: SESSION_ARCHIVE_REQUEST_TIMEOUT_MS },
        )) as SessionsDeleteResult;
        if (!response.deleted) {
          results[index] = notFoundResult(session.key, agent);
          continue;
        }
        results[index] = {
          key: response.key ?? session.key,
          ok: true,
          status: "deleted",
          archived: response.archived ?? [],
          ...(response.worktreePreserved ? { worktreePreserved: response.worktreePreserved } : {}),
        };
      }
    } catch (error) {
      results[index] = {
        key: session.key,
        ok: false,
        status: "failed",
        error: formatErrorMessage(error),
      };
    }
  }

  outputLifecycleResults(
    operation,
    Boolean(opts.dryRun),
    results.filter((result) => result !== undefined),
    runtime,
    Boolean(opts.json),
  );
}

/** Archive one or more stored sessions through the same Gateway patch used by Control UI. */
export async function sessionsArchiveCommand(
  opts: SessionsLifecycleCliOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  await runSessionsLifecycleCommand("archive", opts, runtime);
}

/** Delete one or more stored sessions through the same Gateway lifecycle owner used by Control UI. */
export async function sessionsDeleteCommand(
  opts: SessionsLifecycleCliOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  await runSessionsLifecycleCommand("delete", opts, runtime);
}
