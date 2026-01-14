import { buildWorkspaceSkillStatus } from "../agents/skills-status.js";
import { withProgress } from "../cli/progress.js";
import {
  loadConfig,
  readConfigFileSnapshot,
  resolveGatewayPort,
} from "../config/config.js";
import { readLastGatewayErrorLine } from "../daemon/diagnostics.js";
import { resolveGatewayLogPaths } from "../daemon/launchd.js";
import { resolveGatewayService } from "../daemon/service.js";
import { buildGatewayConnectionDetails, callGateway } from "../gateway/call.js";
import { normalizeControlUiBasePath } from "../gateway/control-ui.js";
import { probeGateway } from "../gateway/probe.js";
import { collectChannelStatusIssues } from "../infra/channels-status-issues.js";
import { resolveClawdbotPackageRoot } from "../infra/clawdbot-root.js";
import { resolveOsSummary } from "../infra/os-summary.js";
import { formatPortDiagnostics, inspectPortUsage } from "../infra/ports.js";
import {
  readRestartSentinel,
  summarizeRestartSentinel,
} from "../infra/restart-sentinel.js";
import { readTailscaleStatusJson } from "../infra/tailscale.js";
import {
  checkUpdateStatus,
  compareSemverStrings,
} from "../infra/update-check.js";
import { runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { renderTable } from "../terminal/table.js";
import { isRich, theme } from "../terminal/theme.js";
import { VERSION } from "../version.js";
import { resolveControlUiLinks } from "./onboard-helpers.js";
import { getAgentLocalStatuses } from "./status-all/agents.js";
import { buildChannelsTable } from "./status-all/channels.js";
import {
  formatAge,
  formatDuration,
  formatGatewayAuthUsed,
  redactSecrets,
} from "./status-all/format.js";
import {
  pickGatewaySelfPresence,
  readFileTailLines,
  summarizeLogTail,
} from "./status-all/gateway.js";

export async function statusAllCommand(
  runtime: RuntimeEnv,
  opts?: { timeoutMs?: number },
): Promise<void> {
  await withProgress(
    { label: "Scanning status --all…", total: 11 },
    async (progress) => {
      progress.setLabel("Loading config…");
      const cfg = loadConfig();
      const osSummary = resolveOsSummary();
      const snap = await readConfigFileSnapshot().catch(() => null);
      progress.tick();

      progress.setLabel("Checking Tailscale…");
      const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
      const tailscale = await (async () => {
        try {
          const parsed = await readTailscaleStatusJson(runExec, {
            timeoutMs: 1200,
          });
          const backendState =
            typeof parsed.BackendState === "string"
              ? parsed.BackendState
              : null;
          const self =
            typeof parsed.Self === "object" && parsed.Self !== null
              ? (parsed.Self as Record<string, unknown>)
              : null;
          const dnsNameRaw =
            self && typeof self.DNSName === "string" ? self.DNSName : null;
          const dnsName = dnsNameRaw ? dnsNameRaw.replace(/\.$/, "") : null;
          const ips =
            self && Array.isArray(self.TailscaleIPs)
              ? (self.TailscaleIPs as unknown[])
                  .filter((v) => typeof v === "string" && v.trim().length > 0)
                  .map((v) => (v as string).trim())
              : [];
          return { ok: true as const, backendState, dnsName, ips, error: null };
        } catch (err) {
          return {
            ok: false as const,
            backendState: null,
            dnsName: null,
            ips: [] as string[],
            error: String(err),
          };
        }
      })();
      const tailscaleHttpsUrl =
        tailscaleMode !== "off" && tailscale.dnsName
          ? `https://${tailscale.dnsName}${normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath)}`
          : null;
      progress.tick();

      progress.setLabel("Checking for updates…");
      const root = await resolveClawdbotPackageRoot({
        moduleUrl: import.meta.url,
        argv1: process.argv[1],
        cwd: process.cwd(),
      });
      const update = await checkUpdateStatus({
        root,
        timeoutMs: 6500,
        fetchGit: true,
        includeRegistry: true,
      });
      progress.tick();

      progress.setLabel("Probing gateway…");
      const connection = buildGatewayConnectionDetails({ config: cfg });
      const isRemoteMode = cfg.gateway?.mode === "remote";
      const remoteUrlRaw =
        typeof cfg.gateway?.remote?.url === "string"
          ? cfg.gateway.remote.url.trim()
          : "";
      const remoteUrlMissing = isRemoteMode && !remoteUrlRaw;
      const gatewayMode = isRemoteMode ? "remote" : "local";

      const resolveProbeAuth = (mode: "local" | "remote") => {
        const authToken = cfg.gateway?.auth?.token;
        const authPassword = cfg.gateway?.auth?.password;
        const remote = cfg.gateway?.remote;
        const token =
          mode === "remote"
            ? typeof remote?.token === "string" && remote.token.trim()
              ? remote.token.trim()
              : undefined
            : process.env.CLAWDBOT_GATEWAY_TOKEN?.trim() ||
              (typeof authToken === "string" && authToken.trim()
                ? authToken.trim()
                : undefined);
        const password =
          process.env.CLAWDBOT_GATEWAY_PASSWORD?.trim() ||
          (mode === "remote"
            ? typeof remote?.password === "string" && remote.password.trim()
              ? remote.password.trim()
              : undefined
            : typeof authPassword === "string" && authPassword.trim()
              ? authPassword.trim()
              : undefined);
        return { token, password };
      };

      const localFallbackAuth = resolveProbeAuth("local");
      const remoteAuth = resolveProbeAuth("remote");

      const gatewayProbe = await probeGateway({
        url: connection.url,
        auth: remoteUrlMissing ? localFallbackAuth : remoteAuth,
        timeoutMs: Math.min(5000, opts?.timeoutMs ?? 10_000),
      }).catch(() => null);
      const gatewayReachable = gatewayProbe?.ok === true;
      const gatewaySelf = pickGatewaySelfPresence(
        gatewayProbe?.presence ?? null,
      );
      progress.tick();

      progress.setLabel("Checking daemon…");
      const daemon = await (async () => {
        try {
          const service = resolveGatewayService();
          const [loaded, runtimeInfo, command] = await Promise.all([
            service
              .isLoaded({
                env: process.env,
                profile: process.env.CLAWDBOT_PROFILE,
              })
              .catch(() => false),
            service.readRuntime(process.env).catch(() => undefined),
            service.readCommand(process.env).catch(() => null),
          ]);
          const installed = command != null;
          return {
            label: service.label,
            installed,
            loaded,
            loadedText: loaded ? service.loadedText : service.notLoadedText,
            runtime: runtimeInfo,
          };
        } catch {
          return null;
        }
      })();
      progress.tick();

      progress.setLabel("Scanning agents…");
      const agentStatus = await getAgentLocalStatuses(cfg);
      progress.tick();
      progress.setLabel("Summarizing channels…");
      const channels = await buildChannelsTable(cfg, { showSecrets: false });
      progress.tick();

      const connectionDetailsForReport = (() => {
        if (!remoteUrlMissing) return connection.message;
        const bindMode = cfg.gateway?.bind ?? "loopback";
        const configPath = snap?.path?.trim()
          ? snap.path.trim()
          : "(unknown config path)";
        return [
          "Gateway mode: remote",
          "Gateway target: (missing gateway.remote.url)",
          `Config: ${configPath}`,
          `Bind: ${bindMode}`,
          `Local fallback (used for probes): ${connection.url}`,
          "Fix: set gateway.remote.url, or set gateway.mode=local.",
        ].join("\n");
      })();

      const callOverrides = remoteUrlMissing
        ? {
            url: connection.url,
            token: localFallbackAuth.token,
            password: localFallbackAuth.password,
          }
        : {};

      progress.setLabel("Querying gateway…");
      const health = gatewayReachable
        ? await callGateway<unknown>({
            method: "health",
            timeoutMs: Math.min(8000, opts?.timeoutMs ?? 10_000),
            ...callOverrides,
          }).catch((err) => ({ error: String(err) }))
        : { error: gatewayProbe?.error ?? "gateway unreachable" };

      const channelsStatus = gatewayReachable
        ? await callGateway<Record<string, unknown>>({
            method: "channels.status",
            params: { probe: false, timeoutMs: opts?.timeoutMs ?? 10_000 },
            timeoutMs: Math.min(8000, opts?.timeoutMs ?? 10_000),
            ...callOverrides,
          }).catch(() => null)
        : null;
      const channelIssues = channelsStatus
        ? collectChannelStatusIssues(channelsStatus)
        : [];
      progress.tick();

      progress.setLabel("Checking local state…");
      const sentinel = await readRestartSentinel().catch(() => null);
      const lastErr = await readLastGatewayErrorLine(process.env).catch(
        () => null,
      );
      const port = resolveGatewayPort(cfg);
      const portUsage = await inspectPortUsage(port).catch(() => null);
      progress.tick();

      const defaultWorkspace =
        agentStatus.agents.find((a) => a.id === agentStatus.defaultId)
          ?.workspaceDir ??
        agentStatus.agents[0]?.workspaceDir ??
        null;
      const skillStatus =
        defaultWorkspace != null
          ? (() => {
              try {
                return buildWorkspaceSkillStatus(defaultWorkspace, {
                  config: cfg,
                });
              } catch {
                return null;
              }
            })()
          : null;

      const controlUiEnabled = cfg.gateway?.controlUi?.enabled ?? true;
      const dashboard = controlUiEnabled
        ? resolveControlUiLinks({
            port,
            bind: cfg.gateway?.bind,
            customBindHost: cfg.gateway?.customBindHost,
            basePath: cfg.gateway?.controlUi?.basePath,
          }).httpUrl
        : null;

      const updateLine = (() => {
        if (update.installKind === "git" && update.git) {
          const parts: string[] = [];
          parts.push(update.git.branch ? `git ${update.git.branch}` : "git");
          if (update.git.upstream) parts.push(`↔ ${update.git.upstream}`);
          if (update.git.dirty) parts.push("dirty");
          if (update.git.behind != null && update.git.ahead != null) {
            if (update.git.behind === 0 && update.git.ahead === 0)
              parts.push("up to date");
            else if (update.git.behind > 0 && update.git.ahead === 0)
              parts.push(`behind ${update.git.behind}`);
            else if (update.git.behind === 0 && update.git.ahead > 0)
              parts.push(`ahead ${update.git.ahead}`);
            else
              parts.push(
                `diverged (ahead ${update.git.ahead}, behind ${update.git.behind})`,
              );
          }
          if (update.git.fetchOk === false) parts.push("fetch failed");

          const latest = update.registry?.latestVersion;
          if (latest) {
            const cmp = compareSemverStrings(VERSION, latest);
            if (cmp === 0) parts.push(`npm latest ${latest}`);
            else if (cmp != null && cmp < 0) parts.push(`npm update ${latest}`);
            else parts.push(`npm latest ${latest} (local newer)`);
          } else if (update.registry?.error) {
            parts.push("npm latest unknown");
          }

          if (update.deps?.status === "ok") parts.push("deps ok");
          if (update.deps?.status === "stale") parts.push("deps stale");
          if (update.deps?.status === "missing") parts.push("deps missing");
          return parts.join(" · ");
        }
        const parts: string[] = [];
        parts.push(
          update.packageManager !== "unknown" ? update.packageManager : "pkg",
        );
        const latest = update.registry?.latestVersion;
        if (latest) {
          const cmp = compareSemverStrings(VERSION, latest);
          if (cmp === 0) parts.push(`npm latest ${latest}`);
          else if (cmp != null && cmp < 0) parts.push(`npm update ${latest}`);
          else parts.push(`npm latest ${latest} (local newer)`);
        } else if (update.registry?.error) {
          parts.push("npm latest unknown");
        }
        if (update.deps?.status === "ok") parts.push("deps ok");
        if (update.deps?.status === "stale") parts.push("deps stale");
        if (update.deps?.status === "missing") parts.push("deps missing");
        return parts.join(" · ");
      })();

      const gatewayTarget = remoteUrlMissing
        ? `fallback ${connection.url}`
        : connection.url;
      const gatewayStatus = gatewayReachable
        ? `reachable ${formatDuration(gatewayProbe?.connectLatencyMs)}`
        : gatewayProbe?.error
          ? `unreachable (${gatewayProbe.error})`
          : "unreachable";
      const gatewayAuth = gatewayReachable
        ? ` · auth ${formatGatewayAuthUsed(remoteUrlMissing ? localFallbackAuth : remoteAuth)}`
        : "";
      const gatewaySelfLine =
        gatewaySelf?.host ||
        gatewaySelf?.ip ||
        gatewaySelf?.version ||
        gatewaySelf?.platform
          ? [
              gatewaySelf.host ? gatewaySelf.host : null,
              gatewaySelf.ip ? `(${gatewaySelf.ip})` : null,
              gatewaySelf.version ? `app ${gatewaySelf.version}` : null,
              gatewaySelf.platform ? gatewaySelf.platform : null,
            ]
              .filter(Boolean)
              .join(" ")
          : null;

      const aliveThresholdMs = 10 * 60_000;
      const aliveAgents = agentStatus.agents.filter(
        (a) =>
          a.lastActiveAgeMs != null && a.lastActiveAgeMs <= aliveThresholdMs,
      ).length;

      const overviewRows = [
        { Item: "Version", Value: VERSION },
        { Item: "OS", Value: osSummary.label },
        { Item: "Node", Value: process.versions.node },
        {
          Item: "Config",
          Value: snap?.path?.trim()
            ? snap.path.trim()
            : "(unknown config path)",
        },
        dashboard
          ? { Item: "Dashboard", Value: dashboard }
          : { Item: "Dashboard", Value: "disabled" },
        {
          Item: "Tailscale",
          Value:
            tailscaleMode === "off"
              ? `off${tailscale.backendState ? ` · ${tailscale.backendState}` : ""}${tailscale.dnsName ? ` · ${tailscale.dnsName}` : ""}`
              : tailscale.dnsName && tailscaleHttpsUrl
                ? `${tailscaleMode} · ${tailscale.backendState ?? "unknown"} · ${tailscale.dnsName} · ${tailscaleHttpsUrl}`
                : `${tailscaleMode} · ${tailscale.backendState ?? "unknown"} · magicdns unknown`,
        },
        { Item: "Update", Value: updateLine },
        {
          Item: "Gateway",
          Value: `${gatewayMode}${remoteUrlMissing ? " (remote.url missing)" : ""} · ${gatewayTarget} (${connection.urlSource}) · ${gatewayStatus}${gatewayAuth}`,
        },
        gatewaySelfLine
          ? { Item: "Gateway self", Value: gatewaySelfLine }
          : { Item: "Gateway self", Value: "unknown" },
        daemon
          ? {
              Item: "Daemon",
              Value:
                daemon.installed === false
                  ? `${daemon.label} not installed`
                  : `${daemon.label} ${daemon.installed ? "installed · " : ""}${daemon.loadedText}${daemon.runtime?.status ? ` · ${daemon.runtime.status}` : ""}${daemon.runtime?.pid ? ` (pid ${daemon.runtime.pid})` : ""}`,
            }
          : { Item: "Daemon", Value: "unknown" },
        {
          Item: "Agents",
          Value: `${agentStatus.agents.length} total · ${agentStatus.bootstrapPendingCount} bootstrapping · ${aliveAgents} active · ${agentStatus.totalSessions} sessions`,
        },
      ];

      const rich = isRich();
      const heading = (text: string) => (rich ? theme.heading(text) : text);
      const ok = (text: string) => (rich ? theme.success(text) : text);
      const warn = (text: string) => (rich ? theme.warn(text) : text);
      const fail = (text: string) => (rich ? theme.error(text) : text);
      const muted = (text: string) => (rich ? theme.muted(text) : text);

      const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);

      const overview = renderTable({
        width: tableWidth,
        columns: [
          { key: "Item", header: "Item", minWidth: 10 },
          { key: "Value", header: "Value", flex: true, minWidth: 24 },
        ],
        rows: overviewRows,
      });

      const channelRows = channels.rows.map((row) => ({
        channelId: row.id,
        Channel: row.label,
        Enabled: row.enabled ? ok("ON") : muted("OFF"),
        State:
          row.state === "ok"
            ? ok("OK")
            : row.state === "warn"
              ? warn("WARN")
              : row.state === "off"
                ? muted("OFF")
                : theme.accentDim("SETUP"),
        Detail: row.detail,
      }));
      const channelIssuesByChannel = (() => {
        const map = new Map<string, typeof channelIssues>();
        for (const issue of channelIssues) {
          const key = issue.channel;
          const list = map.get(key);
          if (list) list.push(issue);
          else map.set(key, [issue]);
        }
        return map;
      })();
      const channelRowsWithIssues = channelRows.map((row) => {
        const issues = channelIssuesByChannel.get(row.channelId) ?? [];
        if (issues.length === 0) return row;
        const issue = issues[0];
        const suffix = ` · ${warn(`gateway: ${String(issue.message).slice(0, 90)}`)}`;
        return {
          ...row,
          State: warn("WARN"),
          Detail: `${row.Detail}${suffix}`,
        };
      });

      const channelsTable = renderTable({
        width: tableWidth,
        columns: [
          { key: "Channel", header: "Channel", minWidth: 10 },
          { key: "Enabled", header: "Enabled", minWidth: 7 },
          { key: "State", header: "State", minWidth: 8 },
          { key: "Detail", header: "Detail", flex: true, minWidth: 28 },
        ],
        rows: channelRowsWithIssues,
      });

      const agentRows = agentStatus.agents.map((a) => ({
        Agent: a.name?.trim() ? `${a.id} (${a.name.trim()})` : a.id,
        Bootstrap:
          a.bootstrapPending === true
            ? warn("PENDING")
            : a.bootstrapPending === false
              ? ok("OK")
              : "unknown",
        Sessions: String(a.sessionsCount),
        Active:
          a.lastActiveAgeMs != null ? formatAge(a.lastActiveAgeMs) : "unknown",
        Store: a.sessionsPath,
      }));

      const agentsTable = renderTable({
        width: tableWidth,
        columns: [
          { key: "Agent", header: "Agent", minWidth: 12 },
          { key: "Bootstrap", header: "Bootstrap", minWidth: 10 },
          { key: "Sessions", header: "Sessions", align: "right", minWidth: 8 },
          { key: "Active", header: "Active", minWidth: 10 },
          { key: "Store", header: "Store", flex: true, minWidth: 34 },
        ],
        rows: agentRows,
      });

      const lines: string[] = [];
      lines.push(heading("Clawdbot status --all"));
      lines.push("");
      lines.push(heading("Overview"));
      lines.push(overview.trimEnd());
      lines.push("");
      lines.push(heading("Channels"));
      lines.push(channelsTable.trimEnd());
      for (const detail of channels.details) {
        lines.push("");
        lines.push(heading(detail.title));
        lines.push(
          renderTable({
            width: tableWidth,
            columns: detail.columns.map((c) => ({
              key: c,
              header: c,
              flex: c === "Notes",
              minWidth: c === "Notes" ? 28 : 10,
            })),
            rows: detail.rows.map((r) => ({
              ...r,
              ...(r.Status === "OK"
                ? { Status: ok("OK") }
                : r.Status === "WARN"
                  ? { Status: warn("WARN") }
                  : {}),
            })),
          }).trimEnd(),
        );
      }
      lines.push("");
      lines.push(heading("Agents"));
      lines.push(agentsTable.trimEnd());
      lines.push("");
      lines.push(heading("Diagnosis (read-only)"));

      const emitCheck = (label: string, status: "ok" | "warn" | "fail") => {
        const icon =
          status === "ok" ? ok("✓") : status === "warn" ? warn("!") : fail("✗");
        const colored =
          status === "ok"
            ? ok(label)
            : status === "warn"
              ? warn(label)
              : fail(label);
        lines.push(`${icon} ${colored}`);
      };

      lines.push("");
      lines.push(`${muted("Gateway connection details:")}`);
      for (const line of redactSecrets(connectionDetailsForReport)
        .split("\n")
        .map((l) => l.trimEnd())) {
        lines.push(`  ${muted(line)}`);
      }

      lines.push("");
      if (snap) {
        const status = !snap.exists ? "fail" : snap.valid ? "ok" : "warn";
        emitCheck(`Config: ${snap.path ?? "(unknown)"}`, status);
        const issues = [...(snap.legacyIssues ?? []), ...(snap.issues ?? [])];
        const uniqueIssues = issues.filter(
          (issue, index) =>
            issues.findIndex(
              (x) => x.path === issue.path && x.message === issue.message,
            ) === index,
        );
        for (const issue of uniqueIssues.slice(0, 12)) {
          lines.push(`  - ${issue.path}: ${issue.message}`);
        }
        if (uniqueIssues.length > 12) {
          lines.push(`  ${muted(`… +${uniqueIssues.length - 12} more`)}`);
        }
      } else {
        emitCheck("Config: read failed", "warn");
      }

      if (remoteUrlMissing) {
        lines.push("");
        emitCheck(
          "Gateway remote mode misconfigured (gateway.remote.url missing)",
          "warn",
        );
        lines.push(
          `  ${muted("Fix: set gateway.remote.url, or set gateway.mode=local.")}`,
        );
      }

      if (sentinel?.payload) {
        emitCheck("Restart sentinel present", "warn");
        lines.push(
          `  ${muted(`${summarizeRestartSentinel(sentinel.payload)} · ${formatAge(Date.now() - sentinel.payload.ts)}`)}`,
        );
      } else {
        emitCheck("Restart sentinel: none", "ok");
      }

      const lastErrClean = lastErr?.trim() ?? "";
      const isTrivialLastErr =
        lastErrClean.length < 8 || lastErrClean === "}" || lastErrClean === "{";
      if (lastErrClean && !isTrivialLastErr) {
        lines.push("");
        lines.push(`${muted("Gateway last log line:")}`);
        lines.push(`  ${muted(redactSecrets(lastErrClean))}`);
      }

      if (portUsage) {
        const portOk = portUsage.listeners.length === 0;
        emitCheck(`Port ${port}`, portOk ? "ok" : "warn");
        if (!portOk) {
          for (const line of formatPortDiagnostics(portUsage)) {
            lines.push(`  ${muted(line)}`);
          }
        }
      }

      {
        const backend = tailscale.backendState ?? "unknown";
        const okBackend = backend === "Running";
        const hasDns = Boolean(tailscale.dnsName);
        const label =
          tailscaleMode === "off"
            ? `Tailscale: off · ${backend}${tailscale.dnsName ? ` · ${tailscale.dnsName}` : ""}`
            : `Tailscale: ${tailscaleMode} · ${backend}${tailscale.dnsName ? ` · ${tailscale.dnsName}` : ""}`;
        emitCheck(
          label,
          okBackend && (tailscaleMode === "off" || hasDns) ? "ok" : "warn",
        );
        if (tailscale.error) {
          lines.push(`  ${muted(`error: ${tailscale.error}`)}`);
        }
        if (tailscale.ips.length > 0) {
          lines.push(
            `  ${muted(`ips: ${tailscale.ips.slice(0, 3).join(", ")}${tailscale.ips.length > 3 ? "…" : ""}`)}`,
          );
        }
        if (tailscaleHttpsUrl) {
          lines.push(`  ${muted(`https: ${tailscaleHttpsUrl}`)}`);
        }
      }

      if (skillStatus) {
        const eligible = skillStatus.skills.filter((s) => s.eligible).length;
        const missing = skillStatus.skills.filter(
          (s) =>
            s.eligible && Object.values(s.missing).some((arr) => arr.length),
        ).length;
        emitCheck(
          `Skills: ${eligible} eligible · ${missing} missing · ${skillStatus.workspaceDir}`,
          missing === 0 ? "ok" : "warn",
        );
      }

      progress.setLabel("Reading logs…");
      const logPaths = (() => {
        try {
          return resolveGatewayLogPaths(process.env);
        } catch {
          return null;
        }
      })();
      if (logPaths) {
        progress.setLabel("Reading logs…");
        const [stderrTail, stdoutTail] = await Promise.all([
          readFileTailLines(logPaths.stderrPath, 40).catch(() => []),
          readFileTailLines(logPaths.stdoutPath, 40).catch(() => []),
        ]);
        if (stderrTail.length > 0 || stdoutTail.length > 0) {
          lines.push("");
          lines.push(
            `${muted(`Gateway logs (tail, summarized): ${logPaths.logDir}`)}`,
          );
          lines.push(`  ${muted(`# stderr: ${logPaths.stderrPath}`)}`);
          for (const line of summarizeLogTail(stderrTail, { maxLines: 22 }).map(
            redactSecrets,
          )) {
            lines.push(`  ${muted(line)}`);
          }
          lines.push(`  ${muted(`# stdout: ${logPaths.stdoutPath}`)}`);
          for (const line of summarizeLogTail(stdoutTail, { maxLines: 22 }).map(
            redactSecrets,
          )) {
            lines.push(`  ${muted(line)}`);
          }
        }
      }
      progress.tick();

      if (channelsStatus) {
        emitCheck(
          `Channel issues (${channelIssues.length || "none"})`,
          channelIssues.length === 0 ? "ok" : "warn",
        );
        for (const issue of channelIssues.slice(0, 12)) {
          const fixText = issue.fix ? ` · fix: ${issue.fix}` : "";
          lines.push(
            `  - ${issue.channel}[${issue.accountId}] ${issue.kind}: ${issue.message}${fixText}`,
          );
        }
        if (channelIssues.length > 12) {
          lines.push(`  ${muted(`… +${channelIssues.length - 12} more`)}`);
        }
      } else {
        emitCheck(
          `Channel issues skipped (gateway ${gatewayReachable ? "query failed" : "unreachable"})`,
          "warn",
        );
      }

      const healthErr = (() => {
        if (!health || typeof health !== "object") return "";
        const record = health as Record<string, unknown>;
        if (!("error" in record)) return "";
        const value = record.error;
        if (!value) return "";
        if (typeof value === "string") return value;
        try {
          return JSON.stringify(value, null, 2);
        } catch {
          return "[unserializable error]";
        }
      })();
      if (healthErr) {
        lines.push("");
        lines.push(`${muted("Gateway health:")}`);
        lines.push(`  ${muted(redactSecrets(healthErr))}`);
      }

      lines.push("");
      lines.push(muted("Pasteable debug report. Auth tokens redacted."));
      lines.push("Troubleshooting: https://docs.clawd.bot/troubleshooting");
      lines.push("");

      progress.setLabel("Rendering…");
      runtime.log(lines.join("\n"));
      progress.tick();
    },
  );
}
