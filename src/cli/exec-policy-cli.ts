import crypto from "node:crypto";
import type { Command } from "commander";
import { readConfigFileSnapshot, replaceConfigFile } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sanitizeExecApprovalDisplayText } from "../infra/exec-approval-command-display.js";
import {
  collectExecPolicyScopeSnapshots,
  type ExecPolicyScopeSnapshot,
} from "../infra/exec-approvals-effective.js";
import {
  normalizeExecAsk,
  normalizeExecSecurity,
  normalizeExecTarget,
  readExecApprovalsSnapshot,
  restoreExecApprovalsSnapshot,
  saveExecApprovals,
  type ExecApprovalsFile,
  type ExecAsk,
  type ExecSecurity,
  type ExecTarget,
} from "../infra/exec-approvals.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";
import { getTerminalTableWidth, renderTable } from "../terminal/table.js";
import { isRich, theme } from "../terminal/theme.js";

type ExecPolicyPresetName = "yolo" | "cautious" | "deny-all";

type ExecPolicyResolved = {
  host?: ExecTarget;
  security?: ExecSecurity;
  ask?: ExecAsk;
  askFallback?: ExecSecurity;
};

const EXEC_POLICY_PRESETS: Record<ExecPolicyPresetName, Required<ExecPolicyResolved>> = {
  yolo: {
    host: "gateway",
    security: "full",
    ask: "off",
    askFallback: "full",
  },
  cautious: {
    host: "gateway",
    security: "allowlist",
    ask: "on-miss",
    askFallback: "deny",
  },
  "deny-all": {
    host: "gateway",
    security: "deny",
    ask: "off",
    askFallback: "deny",
  },
};

type ExecPolicyShowPayload = {
  configPath: string;
  approvalsPath: string;
  approvalsExists: boolean;
  effectivePolicy: {
    note: string;
    scopes: ExecPolicyShowScope[];
  };
};

type ExecPolicyShowSecurity = ExecSecurity | "unknown";
type ExecPolicyShowAsk = ExecAsk | "unknown";

type ExecPolicyShowScope = Omit<
  ExecPolicyScopeSnapshot,
  "security" | "ask" | "askFallback" | "allowedDecisions"
> & {
  runtimeApprovalsSource: "local-file" | "node-runtime";
  security: {
    requested: ExecSecurity;
    requestedSource: string;
    host: ExecPolicyShowSecurity;
    hostSource: string;
    effective: ExecPolicyShowSecurity;
    note: string;
  };
  ask: {
    requested: ExecAsk;
    requestedSource: string;
    host: ExecPolicyShowAsk;
    hostSource: string;
    effective: ExecPolicyShowAsk;
    note: string;
  };
  askFallback: {
    effective: ExecPolicyShowSecurity;
    source: string;
  };
};

class ExecPolicyCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecPolicyCliError";
  }
}

function failExecPolicy(message: string): never {
  throw new ExecPolicyCliError(message);
}

function formatExecPolicyError(err: unknown): string {
  return sanitizeExecPolicyMessage(err instanceof Error ? err.message : String(err));
}

async function runExecPolicyAction(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    defaultRuntime.error(formatExecPolicyError(err));
    defaultRuntime.exit(1);
  }
}

function sanitizeExecPolicyTableCell(value: string): string {
  return sanitizeExecApprovalDisplayText(sanitizeTerminalText(value));
}

function sanitizeExecPolicyMessage(value: unknown): string {
  return sanitizeTerminalText(String(value));
}

function hashExecApprovalsFile(file: ExecApprovalsFile): string {
  const raw = `${JSON.stringify(file, null, 2)}\n`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function resolveExecPolicyInput(params: {
  host?: string;
  security?: string;
  ask?: string;
  askFallback?: string;
}): ExecPolicyResolved {
  const resolved: ExecPolicyResolved = {};
  if (params.host !== undefined) {
    const host = normalizeExecTarget(params.host);
    if (!host) {
      failExecPolicy(`Invalid exec host: ${sanitizeExecPolicyMessage(params.host)}`);
    }
    resolved.host = host;
  }
  if (params.security !== undefined) {
    const security = normalizeExecSecurity(params.security);
    if (!security) {
      failExecPolicy(`Invalid exec security: ${sanitizeExecPolicyMessage(params.security)}`);
    }
    resolved.security = security;
  }
  if (params.ask !== undefined) {
    const ask = normalizeExecAsk(params.ask);
    if (!ask) {
      failExecPolicy(`Invalid exec ask mode: ${sanitizeExecPolicyMessage(params.ask)}`);
    }
    resolved.ask = ask;
  }
  if (params.askFallback !== undefined) {
    const askFallback = normalizeExecSecurity(params.askFallback);
    if (!askFallback) {
      failExecPolicy(`Invalid exec askFallback: ${sanitizeExecPolicyMessage(params.askFallback)}`);
    }
    resolved.askFallback = askFallback;
  }
  return resolved;
}

function applyConfigExecPolicy(draft: Record<string, unknown>, policy: ExecPolicyResolved): void {
  const root = draft as {
    tools?: {
      exec?: {
        host?: ExecTarget;
        security?: ExecSecurity;
        ask?: ExecAsk;
      };
    };
  };
  root.tools ??= {};
  root.tools.exec ??= {};
  if (policy.host !== undefined) {
    root.tools.exec.host = policy.host;
  }
  if (policy.security !== undefined) {
    root.tools.exec.security = policy.security;
  }
  if (policy.ask !== undefined) {
    root.tools.exec.ask = policy.ask;
  }
}

function applyApprovalsDefaults(
  file: ExecApprovalsFile,
  policy: ExecPolicyResolved,
): ExecApprovalsFile {
  const next: ExecApprovalsFile = structuredClone(file ?? { version: 1 });
  next.version = 1;
  next.defaults ??= {};
  if (policy.security !== undefined) {
    next.defaults.security = policy.security;
  }
  if (policy.ask !== undefined) {
    next.defaults.ask = policy.ask;
  }
  if (policy.askFallback !== undefined) {
    next.defaults.askFallback = policy.askFallback;
  }
  return next;
}

function buildNextExecPolicyConfig(
  config: OpenClawConfig,
  policy: ExecPolicyResolved,
): OpenClawConfig {
  const draft = structuredClone(config);
  applyConfigExecPolicy(draft as Record<string, unknown>, policy);
  return draft;
}

async function buildLocalExecPolicyShowPayload(): Promise<ExecPolicyShowPayload> {
  const configSnapshot = await readConfigFileSnapshot();
  const approvalsSnapshot = readExecApprovalsSnapshot();
  const scopes = collectExecPolicyScopeSnapshots({
    cfg: configSnapshot.config ?? {},
    approvals: approvalsSnapshot.file,
    hostPath: approvalsSnapshot.path,
  }).map(buildExecPolicyShowScope);
  const hasNodeRuntimeScope = scopes.some(
    (scope) => scope.runtimeApprovalsSource === "node-runtime",
  );
  return {
    configPath: configSnapshot.path,
    approvalsPath: approvalsSnapshot.path,
    approvalsExists: approvalsSnapshot.exists,
    effectivePolicy: {
      note: hasNodeRuntimeScope
        ? "Scopes requesting host=node are node-managed at runtime. Local approvals are shown only for local/gateway scopes."
        : "Effective exec policy is the host approvals file intersected with requested tools.exec policy.",
      scopes,
    },
  };
}

function buildExecPolicyShowScope(snapshot: ExecPolicyScopeSnapshot): ExecPolicyShowScope {
  const { allowedDecisions: _allowedDecisions, ...baseScope } = snapshot;
  if (snapshot.host.requested !== "node") {
    return {
      ...baseScope,
      runtimeApprovalsSource: "local-file",
    };
  }
  return {
    ...baseScope,
    runtimeApprovalsSource: "node-runtime",
    security: {
      requested: snapshot.security.requested,
      requestedSource: snapshot.security.requestedSource,
      host: "unknown",
      hostSource: "node runtime approvals",
      effective: "unknown",
      note: "runtime policy resolved by node approvals",
    },
    ask: {
      requested: snapshot.ask.requested,
      requestedSource: snapshot.ask.requestedSource,
      host: "unknown",
      hostSource: "node runtime approvals",
      effective: "unknown",
      note: "runtime policy resolved by node approvals",
    },
    askFallback: {
      effective: "unknown",
      source: "node runtime approvals",
    },
  };
}

function renderExecPolicyShow(payload: ExecPolicyShowPayload): void {
  const rich = isRich();
  const heading = (text: string) => (rich ? theme.heading(text) : text);
  const muted = (text: string) => (rich ? theme.muted(text) : text);
  defaultRuntime.log(heading("Exec Policy"));
  defaultRuntime.log(
    renderTable({
      width: getTerminalTableWidth(),
      columns: [
        { key: "Field", header: "Field", minWidth: 14 },
        { key: "Value", header: "Value", minWidth: 24, flex: true },
      ],
      rows: [
        { Field: "Config", Value: sanitizeExecPolicyTableCell(payload.configPath) },
        { Field: "Approvals", Value: sanitizeExecPolicyTableCell(payload.approvalsPath) },
        {
          Field: "Approvals File",
          Value: sanitizeExecPolicyTableCell(payload.approvalsExists ? "present" : "missing"),
        },
      ],
    }).trimEnd(),
  );
  defaultRuntime.log("");
  defaultRuntime.log(heading("Effective Policy"));
  defaultRuntime.log(
    renderTable({
      width: getTerminalTableWidth(),
      columns: [
        { key: "Scope", header: "Scope", minWidth: 12 },
        { key: "Requested", header: "Requested", minWidth: 24, flex: true },
        { key: "Host", header: "Host", minWidth: 24, flex: true },
        { key: "Effective", header: "Effective", minWidth: 16 },
      ],
      rows: payload.effectivePolicy.scopes.map((scope) => ({
        Scope: sanitizeExecPolicyTableCell(scope.scopeLabel),
        Requested: sanitizeExecPolicyTableCell(
          `host=${scope.host.requested} (${scope.host.requestedSource})\n` +
            `security=${scope.security.requested} (${scope.security.requestedSource})\n` +
            `ask=${scope.ask.requested} (${scope.ask.requestedSource})`,
        ),
        Host: sanitizeExecPolicyTableCell(
          `security=${scope.security.host} (${scope.security.hostSource})\n` +
            `ask=${scope.ask.host} (${scope.ask.hostSource})\n` +
            `askFallback=${scope.askFallback.effective} (${scope.askFallback.source})`,
        ),
        Effective: sanitizeExecPolicyTableCell(
          `security=${scope.security.effective}\nask=${scope.ask.effective}`,
        ),
      })),
    }).trimEnd(),
  );
  defaultRuntime.log("");
  defaultRuntime.log(muted(payload.effectivePolicy.note));
}

async function applyLocalExecPolicy(policy: ExecPolicyResolved): Promise<ExecPolicyShowPayload> {
  const configSnapshot = await readConfigFileSnapshot();
  const nextConfig = buildNextExecPolicyConfig(configSnapshot.config ?? {}, policy);
  if (nextConfig.tools?.exec?.host === "node") {
    failExecPolicy(
      "Local exec-policy cannot synchronize host=node. Node approvals are fetched from the node at runtime.",
    );
  }
  const approvalsSnapshot = readExecApprovalsSnapshot();
  const nextApprovals = applyApprovalsDefaults(approvalsSnapshot.file, policy);
  const writtenApprovalsHash = hashExecApprovalsFile(nextApprovals);
  saveExecApprovals(nextApprovals);
  try {
    await replaceConfigFile({
      baseHash: configSnapshot.hash,
      nextConfig,
    });
  } catch (err) {
    const currentApprovalsSnapshot = readExecApprovalsSnapshot();
    if (currentApprovalsSnapshot.hash !== writtenApprovalsHash) {
      throw err;
    }
    restoreExecApprovalsSnapshot(approvalsSnapshot);
    throw err;
  }
  return await buildLocalExecPolicyShowPayload();
}

export function registerExecPolicyCli(program: Command) {
  const execPolicy = program
    .command("exec-policy")
    .description("Show or synchronize requested exec policy with host approvals")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/approvals", "docs.openclaw.ai/cli/approvals")}\n`,
    );

  execPolicy
    .command("show")
    .description("Show the local config policy, host approvals, and effective merge")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json?: boolean }) => {
      await runExecPolicyAction(async () => {
        const payload = await buildLocalExecPolicyShowPayload();
        if (opts.json) {
          defaultRuntime.writeJson(payload, 0);
          return;
        }
        renderExecPolicyShow(payload);
      });
    });

  execPolicy
    .command("preset <name>")
    .description('Apply a synchronized preset: "yolo", "cautious", or "deny-all"')
    .option("--json", "Output as JSON", false)
    .action(async (name: string, opts: { json?: boolean }) => {
      await runExecPolicyAction(async () => {
        if (!Object.hasOwn(EXEC_POLICY_PRESETS, name)) {
          failExecPolicy(`Unknown exec-policy preset: ${sanitizeExecPolicyMessage(name)}`);
        }
        const preset = EXEC_POLICY_PRESETS[name as ExecPolicyPresetName];
        const payload = await applyLocalExecPolicy(preset);
        if (opts.json) {
          defaultRuntime.writeJson({ preset: name, ...payload }, 0);
          return;
        }
        defaultRuntime.log(`Applied exec-policy preset: ${sanitizeExecPolicyMessage(name)}`);
        defaultRuntime.log("");
        renderExecPolicyShow(payload);
      });
    });

  execPolicy
    .command("set")
    .description("Synchronize local config and host approvals using explicit values")
    .option("--host <host>", "Exec host target: auto|sandbox|gateway|node")
    .option("--security <mode>", "Exec security: deny|allowlist|full")
    .option("--ask <mode>", "Exec ask mode: off|on-miss|always")
    .option("--ask-fallback <mode>", "Host approvals fallback: deny|allowlist|full")
    .option("--json", "Output as JSON", false)
    .action(
      async (opts: {
        host?: string;
        security?: string;
        ask?: string;
        askFallback?: string;
        json?: boolean;
      }) => {
        await runExecPolicyAction(async () => {
          const policy = resolveExecPolicyInput(opts);
          if (Object.keys(policy).length === 0) {
            failExecPolicy("Provide at least one of --host, --security, --ask, or --ask-fallback.");
          }
          const payload = await applyLocalExecPolicy(policy);
          if (opts.json) {
            defaultRuntime.writeJson({ applied: policy, ...payload }, 0);
            return;
          }
          defaultRuntime.log("Synchronized local exec policy.");
          defaultRuntime.log("");
          renderExecPolicyShow(payload);
        });
      },
    );
}
