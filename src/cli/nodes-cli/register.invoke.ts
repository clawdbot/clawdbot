import type { Command } from "commander";
import { randomIdempotencyKey } from "../../gateway/call.js";
import { defaultRuntime } from "../../runtime.js";
import { parseEnvPairs, parseTimeoutMs } from "../nodes-run.js";
import {
  callGatewayCli,
  nodesCallOpts,
  resolveNodeId,
  unauthorizedHintForMessage,
} from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

export function registerNodesInvokeCommands(nodes: Command) {
  nodesCallOpts(
    nodes
      .command("invoke")
      .description("Invoke a command on a paired node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .requiredOption("--command <command>", "Command (e.g. canvas.eval)")
      .option("--params <json>", "JSON object string for params", "{}")
      .option(
        "--invoke-timeout <ms>",
        "Node invoke timeout in ms (default 15000)",
        "15000",
      )
      .option("--idempotency-key <key>", "Idempotency key (optional)")
      .action(async (opts: NodesRpcOpts) => {
        try {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const command = String(opts.command ?? "").trim();
          if (!nodeId || !command) {
            defaultRuntime.error("--node and --command required");
            defaultRuntime.exit(1);
            return;
          }
          const params = JSON.parse(String(opts.params ?? "{}")) as unknown;
          const timeoutMs = opts.invokeTimeout
            ? Number.parseInt(String(opts.invokeTimeout), 10)
            : undefined;

          const invokeParams: Record<string, unknown> = {
            nodeId,
            command,
            params,
            idempotencyKey: String(
              opts.idempotencyKey ?? randomIdempotencyKey(),
            ),
          };
          if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
            invokeParams.timeoutMs = timeoutMs;
          }

          const result = await callGatewayCli(
            "node.invoke",
            opts,
            invokeParams,
          );
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(`nodes invoke failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
    { timeoutMs: 30_000 },
  );

  nodesCallOpts(
    nodes
      .command("run")
      .description("Run a shell command on a node (mac only)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--cwd <path>", "Working directory")
      .option(
        "--env <key=val>",
        "Environment override (repeatable)",
        (value: string, prev: string[] = []) => [...prev, value],
      )
      .option("--command-timeout <ms>", "Command timeout (ms)")
      .option("--needs-screen-recording", "Require screen recording permission")
      .option(
        "--invoke-timeout <ms>",
        "Node invoke timeout in ms (default 30000)",
        "30000",
      )
      .argument("<command...>", "Command and args")
      .action(async (command: string[], opts: NodesRpcOpts) => {
        try {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          if (!Array.isArray(command) || command.length === 0) {
            throw new Error("command required");
          }
          const env = parseEnvPairs(opts.env);
          const timeoutMs = parseTimeoutMs(opts.commandTimeout);
          const invokeTimeout = parseTimeoutMs(opts.invokeTimeout);

          const invokeParams: Record<string, unknown> = {
            nodeId,
            command: "system.run",
            params: {
              command,
              cwd: opts.cwd,
              env,
              timeoutMs,
              needsScreenRecording: opts.needsScreenRecording === true,
            },
            idempotencyKey: String(
              opts.idempotencyKey ?? randomIdempotencyKey(),
            ),
          };
          if (invokeTimeout !== undefined) {
            invokeParams.timeoutMs = invokeTimeout;
          }

          const result = (await callGatewayCli(
            "node.invoke",
            opts,
            invokeParams,
          )) as unknown;
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }

          const payload =
            typeof result === "object" && result !== null
              ? (result as { payload?: Record<string, unknown> }).payload
              : undefined;

          const stdout =
            typeof payload?.stdout === "string" ? payload.stdout : "";
          const stderr =
            typeof payload?.stderr === "string" ? payload.stderr : "";
          const exitCode =
            typeof payload?.exitCode === "number" ? payload.exitCode : null;
          const timedOut = payload?.timedOut === true;
          const success = payload?.success === true;

          if (stdout) process.stdout.write(stdout);
          if (stderr) process.stderr.write(stderr);
          if (timedOut) {
            defaultRuntime.error("run timed out");
            defaultRuntime.exit(1);
            return;
          }
          if (exitCode !== null && exitCode !== 0) {
            const hint = unauthorizedHintForMessage(`${stderr}\n${stdout}`);
            if (hint) defaultRuntime.error(hint);
          }
          if (exitCode !== null && exitCode !== 0 && !success) {
            defaultRuntime.error(`run exit ${exitCode}`);
            defaultRuntime.exit(1);
            return;
          }
        } catch (err) {
          defaultRuntime.error(`nodes run failed: ${String(err)}`);
          const hint = unauthorizedHintForMessage(String(err));
          if (hint) defaultRuntime.error(hint);
          defaultRuntime.exit(1);
        }
      }),
    { timeoutMs: 35_000 },
  );
}
