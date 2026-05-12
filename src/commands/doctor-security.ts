import { resolveDmAllowAuditState } from "../channels/message-access/dm-allow-state.js";
import { listReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig, GatewayBindMode } from "../config/config.js";
import type { AgentConfig } from "../config/types.agents.js";
import { hasConfiguredSecretInput } from "../config/types.secrets.js";
import { resolveGatewayAuthTokenSourceConflict } from "../gateway/auth-token-source-conflict.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { isLoopbackHost, resolveGatewayBindHost } from "../gateway/net.js";
import { resolveExecPolicyScopeSnapshot } from "../infra/exec-approvals-effective.js";
import { loadExecApprovals, type ExecAsk, type ExecSecurity } from "../infra/exec-approvals.js";
import { collectExecFilesystemPolicyDriftHits } from "../security/exec-filesystem-policy.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { note } from "../terminal/note.js";
import { resolveDefaultChannelAccountContext } from "./channel-account-context.js";

function collectImplicitHeartbeatDirectPolicyWarnings(cfg: OpenClawConfig): string[] {
  const warnings: string[] = [];

  const maybeWarn = (params: {
    label: string;
    heartbeat: AgentConfig["heartbeat"] | undefined;
    pathHint: string;
  }) => {
    const heartbeat = params.heartbeat;
    if (!heartbeat || heartbeat.target === undefined || heartbeat.target === "none") {
      return;
    }
    if (heartbeat.directPolicy !== undefined) {
      return;
    }
    warnings.push(
      `- ${params.label}: heartbeat delivery is configured while ${params.pathHint} is unset.`,
      '  Heartbeat now allows direct/DM targets by default. Set it explicitly to "allow" or "block" to pin upgrade behavior.',
    );
  };

  maybeWarn({
    label: "Heartbeat defaults",
    heartbeat: cfg.agents?.defaults?.heartbeat,
    pathHint: "agents.defaults.heartbeat.directPolicy",
  });

  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  for (const agent of agents) {
    maybeWarn({
      label: `Heartbeat agent "${agent.id}"`,
      heartbeat: agent.heartbeat,
      pathHint: `heartbeat.directPolicy for agent "${agent.id}"`,
    });
  }

  return warnings;
}

function execSecurityRank(value: ExecSecurity): number {
  switch (value) {
    case "deny":
      return 0;
    case "allowlist":
      return 1;
    case "full":
      return 2;
  }
  throw new Error("Unsupported exec security value");
}

function execAskRank(value: ExecAsk): number {
  switch (value) {
    case "off":
      return 0;
    case "on-miss":
      return 1;
    case "always":
      return 2;
  }
  throw new Error("Unsupported exec ask value");
}

function collectExecPolicyConflictWarnings(cfg: OpenClawConfig): string[] {
  const warnings: string[] = [];
  const approvals = loadExecApprovals();
  const defaultRequestedSecuritySource = "OpenClaw default (full)";
  const defaultRequestedAskSource = "OpenClaw default (off)";

  const maybeWarn = (params: {
    scopeLabel: string;
    scopeExecConfig: { security?: ExecSecurity; ask?: ExecAsk } | undefined;
    globalExecConfig?: { security?: ExecSecurity; ask?: ExecAsk } | undefined;
    agentId?: string;
  }) => {
    const scopeExecConfig = params.scopeExecConfig;
    const globalExecConfig = params.globalExecConfig;
    if (
      !scopeExecConfig?.security &&
      !scopeExecConfig?.ask &&
      !globalExecConfig?.security &&
      !globalExecConfig?.ask
    ) {
      return;
    }
    const snapshot = resolveExecPolicyScopeSnapshot({
      approvals,
      scopeExecConfig,
      globalExecConfig,
      configPath:
        params.scopeLabel === "tools.exec"
          ? "tools.exec"
          : `agents.list.${params.agentId}.tools.exec`,
      scopeLabel: params.scopeLabel,
      agentId: params.agentId,
    });
    const securityConfigured = snapshot.security.requestedSource !== defaultRequestedSecuritySource;
    const askConfigured = snapshot.ask.requestedSource !== defaultRequestedAskSource;
    const securityConflict =
      securityConfigured &&
      execSecurityRank(snapshot.security.requested) > execSecurityRank(snapshot.security.effective);
    const askConflict =
      askConfigured && execAskRank(snapshot.ask.requested) < execAskRank(snapshot.ask.effective);
    if (!securityConflict && !askConflict) {
      return;
    }

    const configParts: string[] = [];
    const hostParts: string[] = [];
    if (securityConflict) {
      configParts.push(`${snapshot.security.requestedSource}="${snapshot.security.requested}"`);
      hostParts.push(`${snapshot.security.hostSource}="${snapshot.security.host}"`);
    }
    if (askConflict) {
      configParts.push(`${snapshot.ask.requestedSource}="${snapshot.ask.requested}"`);
      hostParts.push(`${snapshot.ask.hostSource}="${snapshot.ask.host}"`);
    }

    warnings.push(
      [
        `- ${params.scopeLabel} is broader than the host exec policy.`,
        `  Config: ${configParts.join(", ")}`,
        `  Host: ${hostParts.join(", ")}`,
        `  Effective host exec stays security="${snapshot.security.effective}" ask="${snapshot.ask.effective}" because the stricter side wins.`,
        "  Headless runs like isolated cron cannot answer approval prompts; align both files or enable Web UI, terminal UI, or chat exec approvals.",
        `  Inspect with: ${formatCliCommand("openclaw approvals get --gateway")}`,
      ].join("\n"),
    );
  };

  maybeWarn({
    scopeLabel: "tools.exec",
    scopeExecConfig: cfg.tools?.exec,
  });

  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  for (const agent of agents) {
    maybeWarn({
      scopeLabel: `agents.list.${agent.id}.tools.exec`,
      scopeExecConfig: agent.tools?.exec,
      globalExecConfig: cfg.tools?.exec,
      agentId: agent.id,
    });
  }

  return warnings;
}

function collectDurableExecApprovalWarnings(cfg: OpenClawConfig): string[] {
  void cfg;
  return [];
}

function collectExecFilesystemPolicyWarnings(cfg: OpenClawConfig): string[] {
  return collectExecFilesystemPolicyDriftHits(cfg).map((hit) =>
    [
      `- ${hit.scopeLabel}: filesystem write tools are disabled, but exec is still available.`,
      `  Runtime tools: ${hit.runtimeTools.join(", ")}; disabled filesystem tools: ${hit.disabledFilesystemTools.join(", ")}.`,
      `  Effective exec host is "${hit.execHost}" with sandbox.mode="${hit.sandboxMode}" and workspaceAccess="${hit.sandboxWorkspaceAccess}".`,
      "  The exec shell can still write wherever that host or sandbox filesystem permits.",
      '  For read-only agents, also deny exec/process; otherwise use sandbox mode "all" with workspaceAccess "ro" or "none".',
    ].join("\n"),
  );
}

export async function noteSecurityWarnings(cfg: OpenClawConfig) {
  const warnings: string[] = [];
  const auditHint = `- Run: ${formatCliCommand("openclaw security audit --deep")}`;

  if (cfg.approvals?.exec?.enabled === false) {
    warnings.push(
      "- Note: approvals.exec.enabled=false disables approval forwarding only.",
      "  Host exec gating still comes from ~/.openclaw/exec-approvals.json.",
      `  Check local policy with: ${formatCliCommand("openclaw approvals get --gateway")}`,
    );
  }

  warnings.push(...collectImplicitHeartbeatDirectPolicyWarnings(cfg));
  warnings.push(...collectExecPolicyConflictWarnings(cfg));
  warnings.push(...collectExecFilesystemPolicyWarnings(cfg));
  warnings.push(...collectDurableExecApprovalWarnings(cfg));

  // ===========================================
  // GATEWAY NETWORK EXPOSURE CHECK
  // ===========================================
  // Check for dangerous gateway binding configurations
  // that expose the gateway to network without proper auth

  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  const gatewayBind = (cfg.gateway?.bind ?? "loopback") as string;
  const customBindHost = cfg.gateway?.customBindHost?.trim();
  const bindModes: GatewayBindMode[] = ["auto", "lan", "loopback", "custom", "tailnet"];
  const bindMode = bindModes.includes(gatewayBind as GatewayBindMode)
    ? (gatewayBind as GatewayBindMode)
    : undefined;
  const resolvedBindHost = bindMode
    ? await resolveGatewayBindHost(bindMode, customBindHost)
    : "0.0.0.0";
  const isExposed = !isLoopbackHost(resolvedBindHost);

  const resolvedAuth = resolveGatewayAuth({
    authConfig: cfg.gateway?.auth,
    env: process.env,
    tailscaleMode,
  });
  const authToken = normalizeOptionalString(resolvedAuth.token) ?? "";
  const authPassword = normalizeOptionalString(resolvedAuth.password) ?? "";
  const hasToken =
    authToken.length > 0 ||
    hasConfiguredSecretInput(cfg.gateway?.auth?.token, cfg.secrets?.defaults);
  const hasPassword =
    authPassword.length > 0 ||
    hasConfiguredSecretInput(cfg.gateway?.auth?.password, cfg.secrets?.defaults);
  const hasSharedSecret =
    (resolvedAuth.mode === "token" && hasToken) ||
    (resolvedAuth.mode === "password" && hasPassword);
  const bindDescriptor = `"${gatewayBind}" (${resolvedBindHost})`;
  const saferRemoteAccessLines = [
    "  Safer remote access: keep bind loopback and use Tailscale Serve/Funnel or an SSH tunnel.",
    "  Example tunnel: ssh -N -L 18789:127.0.0.1:18789 user@gateway-host",
    "  Docs: https://docs.openclaw.ai/gateway/remote",
  ];

  if (isExposed) {
    if (!hasSharedSecret) {
      const authFixLines =
        resolvedAuth.mode === "password"
          ? [
              `  Fix: ${formatCliCommand("openclaw configure")} to set a password`,
              `  Or switch to token: ${formatCliCommand("openclaw config set gateway.auth.mode token")}`,
            ]
          : [
              `  Fix: ${formatCliCommand("openclaw doctor --fix")} to generate a token`,
              `  Or set token directly: ${formatCliCommand(
                "openclaw config set gateway.auth.mode token",
              )}`,
            ];
      warnings.push(
        `- CRITICAL: Gateway bound to ${bindDescriptor} without authentication.`,
        `  Anyone on your network (or internet if port-forwarded) can fully control your agent.`,
        `  Fix: ${formatCliCommand("openclaw config set gateway.bind loopback")}`,
        ...saferRemoteAccessLines,
        ...authFixLines,
      );
    } else {
      // Auth is configured, but still warn about network exposure
      warnings.push(
        `- WARNING: Gateway bound to ${bindDescriptor} (network-accessible).`,
        `  Ensure your auth credentials are strong and not exposed.`,
        ...saferRemoteAccessLines,
      );
    }
  }

  const tokenConflict = resolveGatewayAuthTokenSourceConflict({ cfg, env: process.env });
  if (tokenConflict) {
    warnings.push(...tokenConflict.warningLines);
  }

  const warnDmPolicy = async (params: {
    label: string;
    provider: ChannelId;
    accountId: string;
    dmPolicy: string;
    allowFrom?: Array<string | number> | null;
    policyPath?: string;
    allowFromPath: string;
    approveHint: string;
    normalizeEntry?: (raw: string) => string;
  }) => {
    const dmPolicy = params.dmPolicy;
    const policyPath = params.policyPath ?? `${params.allowFromPath}policy`;
    const { hasWildcard, allowCount, isMultiUserDm } = await resolveDmAllowAuditState({
      provider: params.provider,
      accountId: params.accountId,
      allowFrom: params.allowFrom,
      dmPolicy,
      normalizeEntry: params.normalizeEntry,
    });
    const dmScope = cfg.session?.dmScope ?? "main";

    if (dmPolicy === "open") {
      const allowFromPath = `${params.allowFromPath}allowFrom`;
      warnings.push(`- ${params.label} DMs: OPEN (${policyPath}="open"). Anyone can DM it.`);
      if (!hasWildcard) {
        warnings.push(
          `- ${params.label} DMs: config invalid — "open" requires ${allowFromPath} to include "*".`,
        );
      }
    }

    if (dmPolicy === "disabled") {
      warnings.push(`- ${params.label} DMs: disabled (${policyPath}="disabled").`);
      return;
    }

    if (dmPolicy !== "open" && allowCount === 0) {
      warnings.push(
        `- ${params.label} DMs: locked (${policyPath}="${dmPolicy}") with no allowlist; unknown senders will be blocked / get a pairing code.`,
      );
      warnings.push(`  ${params.approveHint}`);
    }

    if (dmScope === "main" && isMultiUserDm) {
      warnings.push(
        `- ${params.label} DMs: multiple senders share the main session; run: ` +
          formatCliCommand('openclaw config set session.dmScope "per-channel-peer"') +
          ' (or "per-account-channel-peer" for multi-account channels) to isolate sessions.',
      );
    }
  };

  for (const plugin of listReadOnlyChannelPluginsForConfig(cfg, {
    includePersistedAuthState: true,
    includeSetupFallbackPlugins: true,
  })) {
    if (!plugin.security) {
      continue;
    }
    const { defaultAccountId, account, enabled, configured, diagnostics } =
      await resolveDefaultChannelAccountContext(plugin, cfg, {
        mode: "read_only",
        commandName: "doctor",
      });
    for (const diagnostic of diagnostics) {
      warnings.push(`- [secrets] ${diagnostic}`);
    }
    if (!enabled) {
      continue;
    }
    if (!configured) {
      continue;
    }
    const dmPolicy = plugin.security.resolveDmPolicy?.({
      cfg,
      accountId: defaultAccountId,
      account,
    });
    if (dmPolicy) {
      await warnDmPolicy({
        label: plugin.meta.label ?? plugin.id,
        provider: plugin.id,
        accountId: defaultAccountId,
        dmPolicy: dmPolicy.policy,
        allowFrom: dmPolicy.allowFrom,
        policyPath: dmPolicy.policyPath,
        allowFromPath: dmPolicy.allowFromPath,
        approveHint: dmPolicy.approveHint,
        normalizeEntry: dmPolicy.normalizeEntry,
      });
    }
    if (plugin.security.collectWarnings) {
      const extra = await plugin.security.collectWarnings({
        cfg,
        accountId: defaultAccountId,
        account,
      });
      if (extra?.length) {
        warnings.push(...extra);
      }
    }
  }

  const lines = warnings.length > 0 ? warnings : ["- No channel security warnings detected."];
  lines.push(auditHint);
  note(lines.join("\n"), "Security");
}
