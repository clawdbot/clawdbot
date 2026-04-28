import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { createConfigIO, replaceConfigFile } from "../config/config.js";
import { collectIncludePathsRecursive } from "../config/includes-scan.js";
import { resolveConfigPath, resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runExec } from "../process/exec.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createIcaclsResetCommand, formatIcaclsResetCommand, type ExecFn } from "./windows-acl.js";

export type SecurityFixChmodAction = {
  kind: "chmod";
  path: string;
  mode: number;
  ok: boolean;
  skipped?: string;
  error?: string;
};

export type SecurityFixIcaclsAction = {
  kind: "icacls";
  path: string;
  command: string;
  ok: boolean;
  skipped?: string;
  error?: string;
};

export type SecurityFixAction = SecurityFixChmodAction | SecurityFixIcaclsAction;

export type SecurityFixResult = {
  ok: boolean;
  stateDir: string;
  configPath: string;
  configWritten: boolean;
  changes: string[];
  actions: SecurityFixAction[];
  errors: string[];
};

export type SecurityPermissionTarget = {
  path: string;
  mode: number;
  require: "dir" | "file";
};

async function safeChmod(params: {
  path: string;
  mode: number;
  require: "dir" | "file";
}): Promise<SecurityFixChmodAction> {
  try {
    const st = await fs.lstat(params.path);
    if (st.isSymbolicLink()) {
      return {
        kind: "chmod",
        path: params.path,
        mode: params.mode,
        ok: false,
        skipped: "symlink",
      };
    }
    if (params.require === "dir" && !st.isDirectory()) {
      return {
        kind: "chmod",
        path: params.path,
        mode: params.mode,
        ok: false,
        skipped: "not-a-directory",
      };
    }
    if (params.require === "file" && !st.isFile()) {
      return {
        kind: "chmod",
        path: params.path,
        mode: params.mode,
        ok: false,
        skipped: "not-a-file",
      };
    }
    const current = st.mode & 0o777;
    if (current === params.mode) {
      return {
        kind: "chmod",
        path: params.path,
        mode: params.mode,
        ok: false,
        skipped: "already",
      };
    }
    await fs.chmod(params.path, params.mode);
    return { kind: "chmod", path: params.path, mode: params.mode, ok: true };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return {
        kind: "chmod",
        path: params.path,
        mode: params.mode,
        ok: false,
        skipped: "missing",
      };
    }
    return {
      kind: "chmod",
      path: params.path,
      mode: params.mode,
      ok: false,
      error: String(err),
    };
  }
}

async function safeAclReset(params: {
  path: string;
  require: "dir" | "file";
  env: NodeJS.ProcessEnv;
  exec?: ExecFn;
}): Promise<SecurityFixIcaclsAction> {
  const display = formatIcaclsResetCommand(params.path, {
    isDir: params.require === "dir",
    env: params.env,
  });
  try {
    const st = await fs.lstat(params.path);
    if (st.isSymbolicLink()) {
      return {
        kind: "icacls",
        path: params.path,
        command: display,
        ok: false,
        skipped: "symlink",
      };
    }
    if (params.require === "dir" && !st.isDirectory()) {
      return {
        kind: "icacls",
        path: params.path,
        command: display,
        ok: false,
        skipped: "not-a-directory",
      };
    }
    if (params.require === "file" && !st.isFile()) {
      return {
        kind: "icacls",
        path: params.path,
        command: display,
        ok: false,
        skipped: "not-a-file",
      };
    }
    const cmd = createIcaclsResetCommand(params.path, {
      isDir: st.isDirectory(),
      env: params.env,
    });
    if (!cmd) {
      return {
        kind: "icacls",
        path: params.path,
        command: display,
        ok: false,
        skipped: "missing-user",
      };
    }
    const exec = params.exec ?? runExec;
    await exec(cmd.command, cmd.args);
    return { kind: "icacls", path: params.path, command: cmd.display, ok: true };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return {
        kind: "icacls",
        path: params.path,
        command: display,
        ok: false,
        skipped: "missing",
      };
    }
    return {
      kind: "icacls",
      path: params.path,
      command: display,
      ok: false,
      error: String(err),
    };
  }
}

function setGroupPolicyAllowlist(params: {
  cfg: OpenClawConfig;
  channel: string;
  changes: string[];
}): void {
  if (!params.cfg.channels) {
    return;
  }
  const section = params.cfg.channels[params.channel as keyof OpenClawConfig["channels"]] as
    | Record<string, unknown>
    | undefined;
  if (!section || typeof section !== "object") {
    return;
  }

  const topPolicy = section.groupPolicy;
  if (topPolicy === "open") {
    section.groupPolicy = "allowlist";
    params.changes.push(`channels.${params.channel}.groupPolicy=open -> allowlist`);
  }

  const accounts = section.accounts;
  if (!accounts || typeof accounts !== "object") {
    return;
  }
  for (const [accountId, accountValue] of Object.entries(accounts)) {
    if (!accountId) {
      continue;
    }
    if (!accountValue || typeof accountValue !== "object") {
      continue;
    }
    const account = accountValue as Record<string, unknown>;
    if (account.groupPolicy === "open") {
      account.groupPolicy = "allowlist";
      params.changes.push(
        `channels.${params.channel}.accounts.${accountId}.groupPolicy=open -> allowlist`,
      );
    }
  }
}

function applyConfigFixes(params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv }): {
  cfg: OpenClawConfig;
  changes: string[];
} {
  const next = structuredClone(params.cfg ?? {});
  const changes: string[] = [];

  if (next.logging?.redactSensitive === "off") {
    next.logging = { ...next.logging, redactSensitive: "tools" };
    changes.push('logging.redactSensitive=off -> "tools"');
  }

  for (const channel of Object.keys(next.channels ?? {})) {
    setGroupPolicyAllowlist({ cfg: next, channel, changes });
  }

  return { cfg: next, changes };
}

export async function applySecurityFixConfigMutations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  channelPlugins?: ChannelPlugin[];
}): Promise<{
  cfg: OpenClawConfig;
  changes: string[];
}> {
  const fixed = applyConfigFixes({ cfg: params.cfg, env: params.env });
  const channelFixes = await collectChannelSecurityConfigFixMutation({
    cfg: fixed.cfg,
    env: params.env,
    channelPlugins: params.channelPlugins,
  });
  return {
    cfg: channelFixes.cfg,
    changes: [...fixed.changes, ...channelFixes.changes],
  };
}

async function collectChannelSecurityConfigFixMutation(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  channelPlugins?: ChannelPlugin[];
}) {
  let nextCfg = params.cfg;
  const changes: string[] = [];
  const collectPlugins = async (): Promise<ChannelPlugin[]> => {
    if (params.channelPlugins) {
      return params.channelPlugins;
    }
    try {
      const pluginIds = Object.keys(params.cfg.channels ?? {}).filter(Boolean);
      if (pluginIds.length === 0) {
        return [];
      }
      const wanted = new Set(pluginIds);
      const { listBundledChannelPlugins } = await import("../channels/plugins/bundled.js");
      return listBundledChannelPlugins().filter((plugin) => wanted.has(plugin.id));
    } catch {
      return [];
    }
  };

  for (const plugin of await collectPlugins()) {
    const mutation = await plugin.security?.applyConfigFixes?.({
      cfg: nextCfg,
      env: params.env,
    });
    if (!mutation || mutation.changes.length === 0) {
      continue;
    }
    nextCfg = mutation.config;
    changes.push(...mutation.changes);
  }
  return { cfg: nextCfg, changes };
}

export async function collectSecurityPermissionTargets(params: {
  env: NodeJS.ProcessEnv;
  stateDir: string;
  configPath: string;
  cfg: OpenClawConfig;
  includePaths?: readonly string[];
}): Promise<SecurityPermissionTarget[]> {
  const targets: SecurityPermissionTarget[] = [
    { path: params.stateDir, mode: 0o700, require: "dir" },
    { path: params.configPath, mode: 0o600, require: "file" },
    ...(params.includePaths ?? []).map((targetPath) => ({
      path: targetPath,
      mode: 0o600,
      require: "file" as const,
    })),
  ];
  const credsDir = resolveOAuthDir(params.env, params.stateDir);
  targets.push({ path: credsDir, mode: 0o700, require: "dir" });

  const credsEntries = await fs.readdir(credsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of credsEntries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.endsWith(".json")) {
      continue;
    }
    const p = path.join(credsDir, entry.name);
    targets.push({ path: p, mode: 0o600, require: "file" });
  }

  const ids = new Set<string>();
  ids.add(resolveDefaultAgentId(params.cfg));
  const list = Array.isArray(params.cfg.agents?.list) ? params.cfg.agents.list : [];
  for (const agent of list ?? []) {
    if (!agent || typeof agent !== "object") {
      continue;
    }
    const id =
      typeof (agent as { id?: unknown }).id === "string" ? (agent as { id: string }).id.trim() : "";
    if (id) {
      ids.add(id);
    }
  }

  for (const agentId of ids) {
    const normalizedAgentId = normalizeAgentId(agentId);
    const agentRoot = path.join(params.stateDir, "agents", normalizedAgentId);
    const agentDir = path.join(agentRoot, "agent");
    const sessionsDir = path.join(agentRoot, "sessions");

    targets.push({ path: agentRoot, mode: 0o700, require: "dir" });
    targets.push({ path: agentDir, mode: 0o700, require: "dir" });

    const authPath = path.join(agentDir, "auth-profiles.json");
    targets.push({ path: authPath, mode: 0o600, require: "file" });

    targets.push({ path: sessionsDir, mode: 0o700, require: "dir" });

    const storePath = path.join(sessionsDir, "sessions.json");
    targets.push({ path: storePath, mode: 0o600, require: "file" });

    // Fix permissions on session transcript files (*.jsonl)
    const sessionEntries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of sessionEntries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) {
        continue;
      }
      const p = path.join(sessionsDir, entry.name);
      targets.push({ path: p, mode: 0o600, require: "file" });
    }
  }
  return targets;
}

export async function fixSecurityFootguns(opts?: {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  configPath?: string;
  platform?: NodeJS.Platform;
  exec?: ExecFn;
  channelPlugins?: ChannelPlugin[];
}): Promise<SecurityFixResult> {
  const env = opts?.env ?? process.env;
  const platform = opts?.platform ?? process.platform;
  const exec = opts?.exec ?? runExec;
  const isWindows = platform === "win32";
  const stateDir = opts?.stateDir ?? resolveStateDir(env);
  const configPath = opts?.configPath ?? resolveConfigPath(env, stateDir);
  const actions: SecurityFixAction[] = [];
  const errors: string[] = [];

  const io = createConfigIO({ env, configPath });
  const { snapshot: snap, writeOptions } = await io.readConfigFileSnapshotForWrite();
  if (!snap.valid) {
    errors.push(...snap.issues.map((i) => `${i.path}: ${i.message}`));
  }

  let configWritten = false;
  let changes: string[] = [];
  if (snap.valid) {
    const fixed = await applySecurityFixConfigMutations({
      cfg: snap.config,
      env,
      channelPlugins: opts?.channelPlugins,
    });
    changes = fixed.changes;

    if (changes.length > 0) {
      try {
        await replaceConfigFile({
          nextConfig: fixed.cfg,
          snapshot: snap,
          writeOptions,
          io,
          afterWrite: { mode: "auto" },
        });
        configWritten = true;
      } catch (err) {
        errors.push(`replaceConfigFile failed: ${String(err)}`);
      }
    }
  }

  const applyPerms = (params: { path: string; mode: number; require: "dir" | "file" }) =>
    isWindows
      ? safeAclReset({ path: params.path, require: params.require, env, exec })
      : safeChmod({ path: params.path, mode: params.mode, require: params.require });
  let includePaths: string[] = [];
  if (snap.exists) {
    includePaths = await collectIncludePathsRecursive({
      configPath: snap.path,
      parsed: snap.parsed,
    }).catch(() => []);
  }

  const permissionTargets = await collectSecurityPermissionTargets({
    env,
    stateDir,
    configPath,
    cfg: snap.config ?? {},
    includePaths,
  }).catch((err) => {
    errors.push(`collectSecurityPermissionTargets failed: ${String(err)}`);
    return [] as SecurityPermissionTarget[];
  });
  for (const target of permissionTargets) {
    actions.push(await applyPerms(target));
  }

  return {
    ok: errors.length === 0,
    stateDir,
    configPath,
    configWritten,
    changes,
    actions,
    errors,
  };
}
