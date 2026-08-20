// Background task and TaskFlow command registration.
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { TASK_FLOW_STATUSES } from "../../tasks/task-flow-registry.types.js";
import {
  TASK_RUNTIMES,
  TASK_STATUSES,
  type TaskNotifyPolicy,
} from "../../tasks/task-registry.types.js";
import {
  TASK_SYSTEM_AUDIT_CODES,
  TASK_SYSTEM_AUDIT_SEVERITIES,
} from "../../tasks/task-system-audit.types.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { inheritOptionFromParent } from "../command-options.js";
import { parseCliEnumFilter } from "../enum-filter.js";

type TasksParentOption = "json" | "runtime" | "status";
const TASKS_PARENT_OPTIONS = ["json", "runtime", "status"] as const;
const TASKS_LEAF_OPTION_SUPPORT = {
  list: TASKS_PARENT_OPTIONS,
  audit: ["json"],
  maintenance: ["json"],
  show: ["json"],
  notify: [],
  cancel: [],
  retry: [],
  dismiss: [],
  "flow list": ["json"],
  "flow show": ["json"],
  "flow cancel": [],
} satisfies Record<string, readonly TasksParentOption[]>;
type TasksLeaf = keyof typeof TASKS_LEAF_OPTION_SUPPORT;

function createModuleLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => (promise ??= load());
}

const loadTasksCommands = createModuleLoader(() => import("../../commands/tasks.js"));
const loadFlowsCommands = createModuleLoader(() => import("../../commands/flows.js"));

async function runOwner<T>(load: () => Promise<T>, action: (owner: T) => Promise<void>) {
  await runCommandWithRuntime(defaultRuntime, async () => action(await load()));
}

function addTasksListOptions(command: Command): Command {
  return command
    .option("--json", "Output as JSON", false)
    .option("--runtime <name>", `Filter by kind (${TASK_RUNTIMES.join(", ")})`)
    .option("--status <name>", `Filter by status (${TASK_STATUSES.join(", ")})`);
}

function isTaskNotifyPolicy(value: unknown): value is TaskNotifyPolicy {
  return value === "done_only" || value === "state_changes" || value === "silent";
}

function resolveTasksLeafOptions(
  command: Command,
  leaf: TasksLeaf,
): { json?: boolean; runtime?: string; status?: string } | undefined {
  const supported: readonly TasksParentOption[] = TASKS_LEAF_OPTION_SUPPORT[leaf];
  const flags = TASKS_PARENT_OPTIONS.filter(
    (name) =>
      !supported.includes(name) && inheritOptionFromParent(command, name, "cli") !== undefined,
  ).map((name) => `--${name}`);
  if (flags.length > 0) {
    defaultRuntime.error(
      `\`tasks ${leaf}\` does not support inherited ${flags.length === 1 ? "option" : "options"} ${flags.join(", ")}.`,
    );
    defaultRuntime.exit(1);
    return undefined;
  }

  const resolveLocal = (name: TasksParentOption): unknown => {
    const source = command.getOptionValueSource(name);
    return source && source !== "default" ? command.getOptionValue(name) : undefined;
  };
  const resolve = (name: TasksParentOption): unknown =>
    resolveLocal(name) ?? inheritOptionFromParent(command, name);
  const json = resolve("json");
  const runtime = resolve("runtime");
  const status = leaf === "flow list" ? resolveLocal("status") : resolve("status");
  return {
    json: typeof json === "boolean" ? json : undefined,
    runtime: typeof runtime === "string" ? runtime : undefined,
    status: typeof status === "string" ? status : undefined,
  };
}

function parseTasksAuditLimit(limit: unknown): number | null | undefined {
  const parsed = parseStrictPositiveInteger(limit);
  if (limit !== undefined && parsed === undefined) {
    defaultRuntime.error("--limit must be a positive integer, for example --limit 25.");
    defaultRuntime.exit(1);
    return null;
  }
  return parsed;
}

export function registerTasksCommand(program: Command): void {
  const tasksCmd = addTasksListOptions(
    program.command("tasks").description("Inspect durable background tasks and TaskFlow state"),
  ).action(async (opts) => {
    await runOwner(loadTasksCommands, ({ tasksListCommand }) =>
      tasksListCommand(
        {
          json: Boolean(opts.json),
          runtime: typeof opts.runtime === "string" ? opts.runtime : undefined,
          status: typeof opts.status === "string" ? opts.status : undefined,
        },
        defaultRuntime,
      ),
    );
  });
  tasksCmd.enablePositionalOptions();

  addTasksListOptions(tasksCmd.command("list").description("List tracked background tasks")).action(
    async (_opts, command) => {
      const resolved = resolveTasksLeafOptions(command, "list");
      if (!resolved) {
        return;
      }
      await runOwner(loadTasksCommands, ({ tasksListCommand }) =>
        tasksListCommand(
          {
            json: Boolean(resolved.json),
            runtime: resolved.runtime,
            status: resolved.status,
          },
          defaultRuntime,
        ),
      );
    },
  );

  tasksCmd
    .command("audit")
    .description("Show stale or broken background tasks and TaskFlows")
    .option("--json", "Output as JSON", false)
    .option("--severity <level>", `Filter by severity (${TASK_SYSTEM_AUDIT_SEVERITIES.join(", ")})`)
    .option("--code <name>", `Filter by finding code (${TASK_SYSTEM_AUDIT_CODES.join(", ")})`)
    .option("--limit <n>", "Limit displayed findings")
    .action(async (opts, command) => {
      const resolved = resolveTasksLeafOptions(command, "audit");
      if (!resolved) {
        return;
      }
      const limit = parseTasksAuditLimit(opts.limit);
      if (limit === null) {
        return;
      }
      await runOwner(loadTasksCommands, ({ tasksAuditCommand }) =>
        tasksAuditCommand(
          {
            json: Boolean(resolved.json),
            severity: parseCliEnumFilter(opts.severity, "--severity", TASK_SYSTEM_AUDIT_SEVERITIES),
            code: parseCliEnumFilter(opts.code, "--code", TASK_SYSTEM_AUDIT_CODES),
            limit,
          },
          defaultRuntime,
        ),
      );
    });

  tasksCmd
    .command("maintenance")
    .description("Preview or apply tasks and TaskFlow maintenance")
    .option("--json", "Output as JSON", false)
    .option("--apply", "Apply reconciliation, cleanup stamping, and pruning", false)
    .action(async (opts, command) => {
      const resolved = resolveTasksLeafOptions(command, "maintenance");
      if (!resolved) {
        return;
      }
      await runOwner(loadTasksCommands, ({ tasksMaintenanceCommand }) =>
        tasksMaintenanceCommand(
          { json: Boolean(resolved.json), apply: Boolean(opts.apply) },
          defaultRuntime,
        ),
      );
    });

  tasksCmd
    .command("show")
    .description("Show one background task by task id, run id, or session key")
    .argument("<lookup>", "Task id, run id, or session key")
    .option("--json", "Output as JSON", false)
    .action(async (lookup, _opts, command) => {
      const resolved = resolveTasksLeafOptions(command, "show");
      if (!resolved) {
        return;
      }
      await runOwner(loadTasksCommands, ({ tasksShowCommand }) =>
        tasksShowCommand({ lookup, json: Boolean(resolved.json) }, defaultRuntime),
      );
    });

  tasksCmd
    .command("notify")
    .description("Set task notify policy")
    .argument("<lookup>", "Task id, run id, or session key")
    .argument("<notify>", "Notify policy (done_only, state_changes, silent)")
    .action(async (lookup, notify, _opts, command) => {
      if (!resolveTasksLeafOptions(command, "notify")) {
        return;
      }
      if (!isTaskNotifyPolicy(notify)) {
        defaultRuntime.error("Notify policy must be done_only, state_changes, or silent.");
        defaultRuntime.exit(1);
        return;
      }
      await runOwner(loadTasksCommands, ({ tasksNotifyCommand }) =>
        tasksNotifyCommand({ lookup, notify }, defaultRuntime),
      );
    });

  tasksCmd
    .command("cancel")
    .description("Cancel a running background task")
    .argument("<lookup>", "Task id, run id, or session key")
    .action(async (lookup, _opts, command) => {
      if (!resolveTasksLeafOptions(command, "cancel")) {
        return;
      }
      await runOwner(loadTasksCommands, ({ tasksCancelCommand }) =>
        tasksCancelCommand({ lookup }, defaultRuntime),
      );
    });

  tasksCmd
    .command("retry <lookups...>")
    .description("Retry delivery for up to 10 blocked subagent completions")
    .action(async (lookups: string[], _opts, command) => {
      if (!resolveTasksLeafOptions(command, "retry")) {
        return;
      }
      await runOwner(loadTasksCommands, ({ tasksRetryCommand }) =>
        tasksRetryCommand({ lookups }, defaultRuntime),
      );
    });

  tasksCmd
    .command("dismiss <lookups...>")
    .description("Dismiss delivery for up to 10 blocked subagent completions")
    .action(async (lookups: string[], _opts, command) => {
      if (!resolveTasksLeafOptions(command, "dismiss")) {
        return;
      }
      await runOwner(loadTasksCommands, ({ tasksDismissCommand }) =>
        tasksDismissCommand({ lookups }, defaultRuntime),
      );
    });

  const tasksFlowCmd = tasksCmd
    .command("flow")
    .description("Inspect durable TaskFlow state under tasks")
    .option("--json", "Output as JSON", false);
  tasksFlowCmd.enablePositionalOptions();

  tasksFlowCmd
    .command("list")
    .description("List tracked TaskFlows")
    .option("--json", "Output as JSON", false)
    .option("--status <name>", `Filter by status (${TASK_FLOW_STATUSES.join(", ")})`)
    .action(async (_opts, command) => {
      const resolved = resolveTasksLeafOptions(command, "flow list");
      if (!resolved) {
        return;
      }
      await runOwner(loadFlowsCommands, ({ flowsListCommand }) =>
        flowsListCommand({ json: Boolean(resolved.json), status: resolved.status }, defaultRuntime),
      );
    });

  tasksFlowCmd
    .command("show")
    .description("Show one TaskFlow by flow id or owner key")
    .argument("<lookup>", "Flow id or owner key")
    .option("--json", "Output as JSON", false)
    .action(async (lookup, _opts, command) => {
      const resolved = resolveTasksLeafOptions(command, "flow show");
      if (!resolved) {
        return;
      }
      await runOwner(loadFlowsCommands, ({ flowsShowCommand }) =>
        flowsShowCommand({ lookup, json: Boolean(resolved.json) }, defaultRuntime),
      );
    });

  tasksFlowCmd
    .command("cancel")
    .description("Cancel a running TaskFlow")
    .argument("<lookup>", "Flow id or owner key")
    .action(async (lookup, _opts, command) => {
      if (!resolveTasksLeafOptions(command, "flow cancel")) {
        return;
      }
      await runOwner(loadFlowsCommands, ({ flowsCancelCommand }) =>
        flowsCancelCommand({ lookup }, defaultRuntime),
      );
    });
}
