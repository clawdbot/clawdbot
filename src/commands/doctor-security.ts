import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelId } from "../channels/plugins/types.js";
import type { ClawdbotConfig } from "../config/config.js";
import { readChannelAllowFromStore } from "../pairing/pairing-store.js";
import { note } from "../terminal/note.js";
import { formatCliCommand } from "../cli/command-format.js";

export async function noteSecurityWarnings(cfg: ClawdbotConfig) {
  const warnings: string[] = [];
  const auditHint = `- Run: ${formatCliCommand("clawdbot security audit --deep")}`;

  // ===========================================
  // GATEWAY NETWORK EXPOSURE CHECK
  // ===========================================
  // Check for dangerous gateway binding configurations
  // that expose the gateway to network without proper auth

  const gatewayBind = cfg.gateway?.bind ?? "loopback";
  const customBindHost = cfg.gateway?.customBindHost?.trim();
  const authMode = cfg.gateway?.auth?.mode ?? "off";
  const authToken = cfg.gateway?.auth?.token;
  const authPassword = cfg.gateway?.auth?.password;

  const isLoopbackBindHost = (host: string) => {
    const normalized = host.trim().toLowerCase();
    return (
      normalized === "localhost" ||
      normalized === "::1" ||
      normalized === "[::1]" ||
      normalized.startsWith("127.")
    );
  };

  // Bindings that expose gateway beyond localhost
  const exposedBindings = ["all", "lan", "0.0.0.0"];
  const isExposed =
    exposedBindings.includes(gatewayBind) ||
    (gatewayBind === "custom" && (!customBindHost || !isLoopbackBindHost(customBindHost)));

  if (isExposed) {
    if (authMode === "off") {
      warnings.push(
        `- CRITICAL: Gateway bound to "${gatewayBind}" with NO authentication.`,
        `  Anyone on your network (or internet if port-forwarded) can fully control your agent.`,
        `  Fix: ${formatCliCommand("clawdbot config set gateway.bind loopback")}`,
        `  Or enable auth: ${formatCliCommand("clawdbot config set gateway.auth.mode token")}`,
      );
    } else if (authMode === "token" && !authToken) {
      warnings.push(
        `- CRITICAL: Gateway bound to "${gatewayBind}" with empty auth token.`,
        `  Fix: ${formatCliCommand("clawdbot doctor --fix")} to generate a token`,
      );
    } else if (authMode === "password" && !authPassword) {
      warnings.push(
        `- CRITICAL: Gateway bound to "${gatewayBind}" with empty password.`,
        `  Fix: ${formatCliCommand("clawdbot configure")} to set a password`,
      );
    } else {
      // Auth is configured, but still warn about network exposure
      warnings.push(
        `- WARNING: Gateway bound to "${gatewayBind}" (network-accessible).`,
        `  Ensure your auth credentials are strong and not exposed.`,
      );
    }
  }

  const warnDmPolicy = async (params: {
    label: string;
    provider: ChannelId;
    dmPolicy: string;
    allowFrom?: Array<string | number> | null;
    policyPath?: string;
    allowFromPath: string;
    approveHint: string;
    normalizeEntry?: (raw: string) => string;
  }) => {
    const dmPolicy = params.dmPolicy;
    const policyPath = params.policyPath ?? `${params.allowFromPath}policy`;
    const configAllowFrom = (params.allowFrom ?? []).map((v) => String(v).trim());
    const hasWildcard = configAllowFrom.includes("*");
    const storeAllowFrom = await readChannelAllowFromStore(params.provider).catch(() => []);
    const normalizedCfg = configAllowFrom
      .filter((v) => v !== "*")
      .map((v) => (params.normalizeEntry ? params.normalizeEntry(v) : v))
      .map((v) => v.trim())
      .filter(Boolean);
    const normalizedStore = storeAllowFrom
      .map((v) => (params.normalizeEntry ? params.normalizeEntry(v) : v))
      .map((v) => v.trim())
      .filter(Boolean);
    const allowCount = Array.from(new Set([...normalizedCfg, ...normalizedStore])).length;
    const dmScope = cfg.session?.dmScope ?? "main";
    const isMultiUserDm = hasWildcard || allowCount > 1;

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
        `- ${params.label} DMs: multiple senders share the main session; set session.dmScope="per-channel-peer" to isolate sessions.`,
      );
    }
  };

  for (const plugin of listChannelPlugins()) {
    if (!plugin.security) continue;
    const accountIds = plugin.config.listAccountIds(cfg);
    const defaultAccountId = resolveChannelDefaultAccountId({
      plugin,
      cfg,
      accountIds,
    });
    const account = plugin.config.resolveAccount(cfg, defaultAccountId);
    const enabled = plugin.config.isEnabled ? plugin.config.isEnabled(account, cfg) : true;
    if (!enabled) continue;
    const configured = plugin.config.isConfigured
      ? await plugin.config.isConfigured(account, cfg)
      : true;
    if (!configured) continue;
    const dmPolicy = plugin.security.resolveDmPolicy?.({
      cfg,
      accountId: defaultAccountId,
      account,
    });
    if (dmPolicy) {
      await warnDmPolicy({
        label: plugin.meta.label ?? plugin.id,
        provider: plugin.id,
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
      if (extra?.length) warnings.push(...extra);
    }
  }

  const lines = warnings.length > 0 ? warnings : ["- No channel security warnings detected."];
  lines.push(auditHint);
  note(lines.join("\n"), "Security");
}
