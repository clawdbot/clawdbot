/**
 * Shared contract between the openclaw-tools MCP stdio entry and the callers
 * that inject it into CLI harness runs. Keep this module free of MCP SDK and
 * tool-runtime imports so CLI-runner prepare paths can build server configs
 * without loading the server.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { CrestodianToolOptions } from "../agents/tools/crestodian-tool.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import type { BundleMcpConfig } from "../plugins/bundle-mcp.js";

export const OPENCLAW_TOOLS_MCP_TOOLS_ENV = "OPENCLAW_TOOLS_MCP_TOOLS";
export const OPENCLAW_TOOLS_MCP_CRESTODIAN_SURFACE_ENV = "OPENCLAW_TOOLS_MCP_CRESTODIAN_SURFACE";
export const OPENCLAW_TOOLS_MCP_CRESTODIAN_APPROVAL_ARMED_ENV =
  "OPENCLAW_TOOLS_MCP_CRESTODIAN_APPROVAL_ARMED";
export const OPENCLAW_TOOLS_MCP_CRESTODIAN_PROPOSAL_ENV = "OPENCLAW_TOOLS_MCP_CRESTODIAN_PROPOSAL";

const OPENCLAW_TOOLS_MCP_TOOL_IDS = ["cron", "crestodian"] as const;
export type OpenClawToolsMcpToolId = (typeof OPENCLAW_TOOLS_MCP_TOOL_IDS)[number];

function isOpenClawToolsMcpToolId(value: string): value is OpenClawToolsMcpToolId {
  return (OPENCLAW_TOOLS_MCP_TOOL_IDS as readonly string[]).includes(value);
}

/** Parse the served tool selection; the default stays cron for acpx bridges. */
export function resolveOpenClawToolsMcpToolSelection(
  env: NodeJS.ProcessEnv = process.env,
): OpenClawToolsMcpToolId[] {
  const raw = env[OPENCLAW_TOOLS_MCP_TOOLS_ENV]?.trim();
  if (!raw) {
    return ["cron"];
  }
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const selection = entries.filter(isOpenClawToolsMcpToolId);
  if (selection.length === 0 || selection.length !== entries.length) {
    throw new Error(
      `${OPENCLAW_TOOLS_MCP_TOOLS_ENV} must be a comma list of: ${OPENCLAW_TOOLS_MCP_TOOL_IDS.join(", ")}`,
    );
  }
  return selection;
}

/** Parse the Crestodian surface for served crestodian tools; defaults to cli. */
export function resolveOpenClawToolsMcpCrestodianSurface(
  env: NodeJS.ProcessEnv = process.env,
): CrestodianToolOptions["surface"] {
  const raw = env[OPENCLAW_TOOLS_MCP_CRESTODIAN_SURFACE_ENV]?.trim();
  if (!raw || raw === "cli") {
    return "cli";
  }
  if (raw === "gateway") {
    return "gateway";
  }
  throw new Error(`${OPENCLAW_TOOLS_MCP_CRESTODIAN_SURFACE_ENV} must be "cli" or "gateway"`);
}

/**
 * Reconstruct per-turn approval state for the served crestodian tool. The
 * stdio server runs out of process, so the host passes the armed bit and the
 * pending proposal hash through env; the host mirrors transitions back from
 * tool events (see mirrorCrestodianProposalFromToolEvents in agent-turn.ts).
 */
export function resolveOpenClawToolsMcpCrestodianApproval(env: NodeJS.ProcessEnv = process.env): {
  approvalArmed: boolean;
  proposalRef: { current?: string };
} {
  const pendingProposal = env[OPENCLAW_TOOLS_MCP_CRESTODIAN_PROPOSAL_ENV]?.trim();
  return {
    approvalArmed: env[OPENCLAW_TOOLS_MCP_CRESTODIAN_APPROVAL_ARMED_ENV]?.trim() === "1",
    proposalRef: pendingProposal ? { current: pendingProposal } : {},
  };
}

function resolveTsxImportSpecifier(): string {
  try {
    return createRequire(import.meta.url).resolve("tsx");
  } catch {
    return "tsx";
  }
}

function resolveOpenClawToolsServeCommand(): { command: string; args: string[] } {
  const packageRoot = resolveOpenClawPackageRootSync({
    argv1: process.argv[1],
    moduleUrl: import.meta.url,
    cwd: process.cwd(),
  });
  if (!packageRoot) {
    throw new Error("openclaw-tools MCP: could not resolve the OpenClaw package root");
  }
  const distEntry = path.join(packageRoot, "dist", "mcp", "openclaw-tools-serve.js");
  if (fs.existsSync(distEntry)) {
    return { command: process.execPath, args: [distEntry] };
  }
  const sourceEntry = path.join(packageRoot, "src", "mcp", "openclaw-tools-serve.ts");
  if (!fs.existsSync(sourceEntry)) {
    throw new Error(`openclaw-tools MCP: no serve entry under ${packageRoot}`);
  }
  // Bun executes TypeScript entries directly; Node source checkouts need tsx.
  if (process.versions.bun) {
    return { command: process.execPath, args: [sourceEntry] };
  }
  return {
    command: process.execPath,
    args: ["--import", resolveTsxImportSpecifier(), sourceEntry],
  };
}

/**
 * Crestodian CLI-harness runs get exactly one MCP server: this stdio entry
 * serving the ring-zero crestodian tool. The server keeps the "openclaw" name
 * so backend tool pre-approvals (e.g. Claude's --allowedTools mcp__openclaw__*)
 * apply without per-backend argument surgery.
 */
export function buildCrestodianToolsMcpServerConfig(
  options: CrestodianToolOptions,
): BundleMcpConfig {
  const entry = resolveOpenClawToolsServeCommand();
  const pendingProposal = options.proposalRef?.current;
  return {
    mcpServers: {
      openclaw: {
        command: entry.command,
        args: entry.args,
        env: {
          [OPENCLAW_TOOLS_MCP_TOOLS_ENV]: "crestodian" satisfies OpenClawToolsMcpToolId,
          [OPENCLAW_TOOLS_MCP_CRESTODIAN_SURFACE_ENV]: options.surface,
          // Per-turn approval state travels with the per-run MCP config; the
          // host mirrors proposal transitions back from tool events.
          ...(options.approvalArmed === true
            ? { [OPENCLAW_TOOLS_MCP_CRESTODIAN_APPROVAL_ARMED_ENV]: "1" }
            : {}),
          ...(pendingProposal
            ? { [OPENCLAW_TOOLS_MCP_CRESTODIAN_PROPOSAL_ENV]: pendingProposal }
            : {}),
        },
      },
    },
  };
}
