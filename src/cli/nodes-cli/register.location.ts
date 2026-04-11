import type { Command } from "commander";
import { randomIdempotencyKey } from "../../gateway/call.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { runNodesCommand } from "./cli-utils.js";
import { callGatewayCli, nodesCallOpts, resolveNodeId } from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

export function registerNodesLocationCommands(nodes: Command) {
  const location = nodes.command("location").description("Fetch location from a paired node");

  nodesCallOpts(
    location
      .command("get")
      .description("Fetch the current location from a node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--max-age <ms>", "Use cached location newer than this (ms)")
      .option(
        "--accuracy <coarse|balanced|precise>",
        "Desired accuracy (default: balanced/precise depending on node setting)",
      )
      .option("--location-timeout <ms>", "Location fix timeout (ms)", "10000")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 20000)", "20000")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("location get", async () => {
          const nodeId = await resolveNodeId(opts, opts.node ?? "");
          const maxAgeMs = opts.maxAge ? Number.parseInt(opts.maxAge, 10) : undefined;
          const desiredAccuracyRaw = normalizeOptionalLowercaseString(opts.accuracy);
          const desiredAccuracy =
            desiredAccuracyRaw === "coarse" ||
            desiredAccuracyRaw === "balanced" ||
            desiredAccuracyRaw === "precise"
              ? desiredAccuracyRaw
              : undefined;
          const timeoutMs = opts.locationTimeout
            ? Number.parseInt(opts.locationTimeout, 10)
            : undefined;
          const invokeTimeoutMs = opts.invokeTimeout
            ? Number.parseInt(opts.invokeTimeout, 10)
            : undefined;

          const invokeParams: Record<string, unknown> = {
            nodeId,
            command: "location.get",
            params: {
              maxAgeMs: Number.isFinite(maxAgeMs) ? maxAgeMs : undefined,
              desiredAccuracy,
              timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
            },
            idempotencyKey: randomIdempotencyKey(),
          };
          if (typeof invokeTimeoutMs === "number" && Number.isFinite(invokeTimeoutMs)) {
            invokeParams.timeoutMs = invokeTimeoutMs;
          }

          const raw = await callGatewayCli("node.invoke", opts, invokeParams);
          const res = typeof raw === "object" && raw !== null ? (raw as { payload?: unknown }) : {};
          const payload =
            res.payload && typeof res.payload === "object"
              ? (res.payload as Record<string, unknown>)
              : {};

          if (opts.json) {
            defaultRuntime.writeJson(payload);
            return;
          }

          const lat = payload.lat;
          const lon = payload.lon;
          const acc = payload.accuracyMeters;
          if (typeof lat === "number" && typeof lon === "number") {
            const accText = typeof acc === "number" ? ` ±${acc.toFixed(1)}m` : "";
            defaultRuntime.log(`${lat},${lon}${accText}`);
            return;
          }
          defaultRuntime.writeJson(payload, 0);
        });
      }),
    { timeoutMs: 30_000 },
  );
}
