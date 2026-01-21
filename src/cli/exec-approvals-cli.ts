import fs from "node:fs/promises";
import JSON5 from "json5";
import type { Command } from "commander";

import type { ExecApprovalsAgent, ExecApprovalsFile } from "../infra/exec-approvals.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { callGatewayFromCli } from "./gateway-rpc.js";
import { nodesCallOpts, resolveNodeId } from "./nodes-cli/rpc.js";
import type { NodesRpcOpts } from "./nodes-cli/types.js";

type ExecApprovalsSnapshot = {
  path: string;
  exists: boolean;
  hash: string;
  file: ExecApprovalsFile;
};

type ExecApprovalsCliOpts = NodesRpcOpts & {
  node?: string;
  file?: string;
  stdin?: boolean;
  agent?: string;
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function resolveTargetNodeId(opts: ExecApprovalsCliOpts): Promise<string | null> {
  const raw = opts.node?.trim() ?? "";
  if (!raw) return null;
  return await resolveNodeId(opts as NodesRpcOpts, raw);
}

async function loadSnapshot(
  opts: ExecApprovalsCliOpts,
  nodeId: string | null,
): Promise<ExecApprovalsSnapshot> {
  const method = nodeId ? "exec.approvals.node.get" : "exec.approvals.get";
  const params = nodeId ? { nodeId } : {};
  const snapshot = (await callGatewayFromCli(method, opts, params)) as ExecApprovalsSnapshot;
  return snapshot;
}

async function saveSnapshot(
  opts: ExecApprovalsCliOpts,
  nodeId: string | null,
  file: ExecApprovalsFile,
  baseHash: string,
): Promise<ExecApprovalsSnapshot> {
  const method = nodeId ? "exec.approvals.node.set" : "exec.approvals.set";
  const params = nodeId ? { nodeId, file, baseHash } : { file, baseHash };
  const snapshot = (await callGatewayFromCli(method, opts, params)) as ExecApprovalsSnapshot;
  return snapshot;
}

function resolveAgentKey(value?: string | null): string {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : "default";
}

function normalizeAllowlistEntry(entry: { pattern?: string } | null): string | null {
  const pattern = entry?.pattern?.trim() ?? "";
  return pattern ? pattern : null;
}

function ensureAgent(file: ExecApprovalsFile, agentKey: string): ExecApprovalsAgent {
  const agents = file.agents ?? {};
  const entry = agents[agentKey] ?? {};
  file.agents = agents;
  return entry;
}

function isEmptyAgent(agent: ExecApprovalsAgent): boolean {
  const allowlist = Array.isArray(agent.allowlist) ? agent.allowlist : [];
  return (
    !agent.security &&
    !agent.ask &&
    !agent.askFallback &&
    agent.autoAllowSkills === undefined &&
    allowlist.length === 0
  );
}

export function registerExecApprovalsCli(program: Command) {
  const formatExample = (cmd: string, desc: string) =>
    `  ${theme.command(cmd)}\n    ${theme.muted(desc)}`;

  const approvals = program
    .command("approvals")
    .alias("exec-approvals")
    .description("Manage exec approvals (gateway or node host)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/approvals", "docs.clawd.bot/cli/approvals")}\n`,
    );

  const getCmd = approvals
    .command("get")
    .description("Fetch exec approvals snapshot")
    .option("--node <node>", "Target node id/name/IP (defaults to gateway)")
    .action(async (opts: ExecApprovalsCliOpts) => {
      const nodeId = await resolveTargetNodeId(opts);
      const snapshot = await loadSnapshot(opts, nodeId);
      const payload = opts.json ? JSON.stringify(snapshot) : JSON.stringify(snapshot, null, 2);
      defaultRuntime.log(payload);
    });
  nodesCallOpts(getCmd);

  const setCmd = approvals
    .command("set")
    .description("Replace exec approvals with a JSON file")
    .option("--node <node>", "Target node id/name/IP (defaults to gateway)")
    .option("--file <path>", "Path to JSON file to upload")
    .option("--stdin", "Read JSON from stdin", false)
    .action(async (opts: ExecApprovalsCliOpts) => {
      if (!opts.file && !opts.stdin) {
        defaultRuntime.error("Provide --file or --stdin.");
        defaultRuntime.exit(1);
        return;
      }
      if (opts.file && opts.stdin) {
        defaultRuntime.error("Use either --file or --stdin (not both).");
        defaultRuntime.exit(1);
        return;
      }
      const nodeId = await resolveTargetNodeId(opts);
      const snapshot = await loadSnapshot(opts, nodeId);
      if (!snapshot.hash) {
        defaultRuntime.error("Exec approvals hash missing; reload and retry.");
        defaultRuntime.exit(1);
        return;
      }
      const raw = opts.stdin ? await readStdin() : await fs.readFile(String(opts.file), "utf8");
      let file: ExecApprovalsFile;
      try {
        file = JSON5.parse(raw) as ExecApprovalsFile;
      } catch (err) {
        defaultRuntime.error(`Failed to parse approvals JSON: ${String(err)}`);
        defaultRuntime.exit(1);
        return;
      }
      file.version = 1;
      const next = await saveSnapshot(opts, nodeId, file, snapshot.hash);
      const payload = opts.json ? JSON.stringify(next) : JSON.stringify(next, null, 2);
      defaultRuntime.log(payload);
    });
  nodesCallOpts(setCmd);

  const allowlist = approvals
    .command("allowlist")
    .description("Edit the per-agent allowlist")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatExample(
          'clawdbot approvals allowlist add "~/Projects/**/bin/rg"',
          "Allowlist a local binary pattern for the default agent.",
        )}\n${formatExample(
          'clawdbot approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"',
          "Allowlist on a specific node/agent.",
        )}\n${formatExample(
          'clawdbot approvals allowlist remove "~/Projects/**/bin/rg"',
          "Remove an allowlist pattern.",
        )}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/approvals", "docs.clawd.bot/cli/approvals")}\n`,
    );

  const allowlistAdd = allowlist
    .command("add <pattern>")
    .description("Add a glob pattern to an allowlist")
    .option("--node <node>", "Target node id/name/IP (defaults to gateway)")
    .option("--agent <id>", 'Agent id (defaults to "default")')
    .action(async (pattern: string, opts: ExecApprovalsCliOpts) => {
      const trimmed = pattern.trim();
      if (!trimmed) {
        defaultRuntime.error("Pattern required.");
        defaultRuntime.exit(1);
        return;
      }
      const nodeId = await resolveTargetNodeId(opts);
      const snapshot = await loadSnapshot(opts, nodeId);
      if (!snapshot.hash) {
        defaultRuntime.error("Exec approvals hash missing; reload and retry.");
        defaultRuntime.exit(1);
        return;
      }
      const file = snapshot.file ?? { version: 1 };
      file.version = 1;
      const agentKey = resolveAgentKey(opts.agent);
      const agent = ensureAgent(file, agentKey);
      const allowlistEntries = Array.isArray(agent.allowlist) ? agent.allowlist : [];
      if (allowlistEntries.some((entry) => normalizeAllowlistEntry(entry) === trimmed)) {
        defaultRuntime.log("Already allowlisted.");
        return;
      }
      allowlistEntries.push({ pattern: trimmed, lastUsedAt: Date.now() });
      agent.allowlist = allowlistEntries;
      file.agents = { ...file.agents, [agentKey]: agent };
      const next = await saveSnapshot(opts, nodeId, file, snapshot.hash);
      const payload = opts.json ? JSON.stringify(next) : JSON.stringify(next, null, 2);
      defaultRuntime.log(payload);
    });
  nodesCallOpts(allowlistAdd);

  const allowlistRemove = allowlist
    .command("remove <pattern>")
    .description("Remove a glob pattern from an allowlist")
    .option("--node <node>", "Target node id/name/IP (defaults to gateway)")
    .option("--agent <id>", 'Agent id (defaults to "default")')
    .action(async (pattern: string, opts: ExecApprovalsCliOpts) => {
      const trimmed = pattern.trim();
      if (!trimmed) {
        defaultRuntime.error("Pattern required.");
        defaultRuntime.exit(1);
        return;
      }
      const nodeId = await resolveTargetNodeId(opts);
      const snapshot = await loadSnapshot(opts, nodeId);
      if (!snapshot.hash) {
        defaultRuntime.error("Exec approvals hash missing; reload and retry.");
        defaultRuntime.exit(1);
        return;
      }
      const file = snapshot.file ?? { version: 1 };
      file.version = 1;
      const agentKey = resolveAgentKey(opts.agent);
      const agent = ensureAgent(file, agentKey);
      const allowlistEntries = Array.isArray(agent.allowlist) ? agent.allowlist : [];
      const nextEntries = allowlistEntries.filter(
        (entry) => normalizeAllowlistEntry(entry) !== trimmed,
      );
      if (nextEntries.length === allowlistEntries.length) {
        defaultRuntime.log("Pattern not found.");
        return;
      }
      if (nextEntries.length === 0) {
        delete agent.allowlist;
      } else {
        agent.allowlist = nextEntries;
      }
      if (isEmptyAgent(agent)) {
        const agents = { ...file.agents };
        delete agents[agentKey];
        file.agents = Object.keys(agents).length > 0 ? agents : undefined;
      } else {
        file.agents = { ...file.agents, [agentKey]: agent };
      }
      const next = await saveSnapshot(opts, nodeId, file, snapshot.hash);
      const payload = opts.json ? JSON.stringify(next) : JSON.stringify(next, null, 2);
      defaultRuntime.log(payload);
    });
  nodesCallOpts(allowlistRemove);
}
