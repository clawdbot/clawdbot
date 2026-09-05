import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveWritableSandboxBindHostRoots,
  type resolveSandboxContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  canonicalPathFromExistingAncestor,
  isPathInside,
} from "openclaw/plugin-sdk/file-access-runtime";
import { resolveCodexAppServerLocalHomeDir } from "./auth-start-options.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { isCodexAppServerProxyLaunch, normalizeCodexAppServerArgs } from "./launch-args.js";
import type { CodexSandboxPolicy } from "./protocol.js";

const SANDBOX_RECOVERY =
  "https://docs.openclaw.ai/plugins/codex-harness#sandboxed-startup-recovery";

/** Own native configuration outside all model-writable mounts before starting its process. */
export async function prepareCodexSandboxNativeContext(params: {
  assertCurrent?: () => void;
  appServer: CodexAppServerRuntimeOptions;
  agentDir: string;
  effectiveWorkspace: string;
  sandbox: Awaited<ReturnType<typeof resolveSandboxContext>>;
  nativeToolSurfaceEnabled: boolean;
}) {
  const { appServer, sandbox } = params;
  if (!sandbox?.enabled || params.nativeToolSurfaceEnabled) {
    return undefined;
  }
  if (
    appServer.start.transport !== "stdio" ||
    appServer.connectionClass === "remote" ||
    isCodexAppServerProxyLaunch(appServer.start.args)
  ) {
    throw new Error(
      `Sandboxed Codex requires a local stdio process that OpenClaw can configure. Select local stdio with agent home and sign in through openclaw models auth login --provider openai; see ${SANDBOX_RECOVERY}.`,
    );
  }
  if (appServer.networkProxy) {
    throw new Error(
      `Sandboxed Codex cannot combine its native sandbox ceiling with a native network permission profile. To disable that profile for all agents using this plugin, run openclaw config set plugins.entries.codex.config.appServer.networkProxy.enabled false --strict-json; review the shared-config impact and recovery steps at ${SANDBOX_RECOVERY}.`,
    );
  }
  const agentDir = await canonicalPathFromExistingAncestor(path.resolve(params.agentDir));
  const codexHome = await canonicalPathFromExistingAncestor(
    resolveCodexAppServerLocalHomeDir(appServer.start, agentDir),
  );
  if (
    appServer.start.homeScope !== "user" &&
    (!isPathInside(agentDir, codexHome) || codexHome === agentDir)
  ) {
    throw new Error(
      `Sandboxed Codex agent home must be inside the protected agent directory. Remove the custom CODEX_HOME from the app-server launch environment, or select homeScope=user for a protected native home; see ${SANDBOX_RECOVERY}.`,
    );
  }
  const cwd = await fs.realpath(params.effectiveWorkspace);
  // Check each bind independently: a read-only shadow must not hide a broader writable mount.
  const modelRoots = [
    params.effectiveWorkspace,
    sandbox.workspaceDir,
    ...(sandbox.workspaceAccess === "none" ? [] : [sandbox.agentWorkspaceDir]),
    ...(sandbox.docker.binds ?? []).flatMap((bind) => resolveWritableSandboxBindHostRoots([bind])),
  ];
  const protectedLaunchRoots = await Promise.all(
    [...new Set(modelRoots)].map((root) => canonicalPathFromExistingAncestor(path.resolve(root))),
  );
  for (const resolvedRoot of protectedLaunchRoots) {
    if (
      [agentDir, codexHome].some(
        (protectedRoot) =>
          isPathInside(resolvedRoot, protectedRoot) || isPathInside(protectedRoot, resolvedRoot),
      )
    ) {
      throw new Error(
        `Sandboxed Codex native configuration overlaps a model-accessible workspace or writable bind. Keep agent state and CODEX_HOME outside writable mounts; inspect openclaw sandbox explain and narrow the affected bind before recreating the agent sandbox; see ${SANDBOX_RECOVERY}.`,
      );
    }
    if (resolvedRoot !== cwd && isPathInside(resolvedRoot, cwd)) {
      // Replacing cwd with a symlink could select another canonical project's
      // trust before our exact workspace pin. The model may write inside cwd,
      // but must not own an ancestor that can replace the workspace mount root.
      throw new Error(
        `Sandboxed Codex cannot protect workspace identity through a model-writable ancestor mount. Narrow the bind to the workspace or its children, or make the ancestor bind read-only, then recreate the agent sandbox; see ${SANDBOX_RECOVERY}.`,
      );
    }
  }
  if (appServer.sessionRoot) {
    const sessionRoot = await canonicalPathFromExistingAncestor(appServer.sessionRoot);
    if (!isPathInside(sessionRoot, cwd)) {
      throw new Error(
        `Sandboxed Codex workspace is outside the resolved session permission root. Select a workspace inside the session's permission root; see ${SANDBOX_RECOVERY}.`,
      );
    }
  }
  const effectiveUid = process.geteuid?.() ?? process.getuid?.();
  // Root already controls the gateway. UID-less platforms retain their existing
  // behavior; POSIX metadata cannot attest Windows ownership or ACLs.
  const isTrustedOwner = (uid: number) => uid === effectiveUid || uid === 0;
  const hasUnsafePosixPermissions = (stat: { uid: number; mode: number }) =>
    effectiveUid !== undefined && (!isTrustedOwner(stat.uid) || (stat.mode & 0o022) !== 0);
  // The default home remains implicit for native artifact ownership. After
  // startup pins agentDir, its final codex-home component must not redirect.
  const nativeHomeDirectory =
    appServer.start.homeScope !== "user" && !appServer.start.env?.CODEX_HOME?.trim()
      ? resolveCodexAppServerLocalHomeDir(appServer.start, agentDir)
      : codexHome;
  for (const directory of new Set([agentDir, nativeHomeDirectory])) {
    // Earlier reads can outlive startup; never begin a write for an abandoned owner.
    params.assertCurrent?.();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || hasUnsafePosixPermissions(stat)) {
      throw new Error(
        `Sandboxed Codex requires protected agent and native home directories owned by the gateway account or root, without group or other write access. Repair the directory ownership and permissions; see ${SANDBOX_RECOVERY}.`,
      );
    }
    if (effectiveUid !== undefined) {
      // A trusted home is replaceable through an untrusted or writable parent.
      // Sticky directories protect their children only when both owners are trusted.
      let childPath = directory;
      let childStat = stat;
      for (
        let ancestor = path.dirname(childPath);
        ancestor !== childPath;
        ancestor = path.dirname(childPath)
      ) {
        const ancestorStat = await fs.lstat(ancestor);
        const stickyProtectsChild =
          (ancestorStat.mode & 0o1000) !== 0 && isTrustedOwner(childStat.uid);
        if (
          !ancestorStat.isDirectory() ||
          !isTrustedOwner(ancestorStat.uid) ||
          ((ancestorStat.mode & 0o022) !== 0 && !stickyProtectsChild)
        ) {
          throw new Error(
            `Sandboxed Codex native configuration has an untrusted or replaceable parent directory. Move agent state and CODEX_HOME under protected ancestors owned by the gateway account or root; see ${SANDBOX_RECOVERY}.`,
          );
        }
        childPath = ancestor;
        childStat = ancestorStat;
      }
    }
  }
  // Native user TOML and hooks.json are refreshed from these paths.
  // A protected directory alone cannot protect linked or writable sources.
  for (const file of ["config.toml", "hooks.json"]) {
    const sourcePath = path.join(codexHome, file);
    const stat = await fs.lstat(sourcePath).catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    });
    if (stat && (!stat.isFile() || stat.nlink !== 1 || hasUnsafePosixPermissions(stat))) {
      throw new Error(
        `Sandboxed Codex native config and hook sources must be regular files owned by the gateway account or root, with one hard link and without group or other write access. Replace linked sources with independent protected files in CODEX_HOME; see ${SANDBOX_RECOVERY}.`,
      );
    }
  }
  // JSON string escapes are valid TOML basic-string escapes; also escape DEL,
  // which JSON permits literally but TOML prohibits inside basic strings.
  const workspaceTrustKey = JSON.stringify(cwd).replace(/\u007f/gu, "\\u007f");
  let args = appServer.start.args;
  for (const override of [
    "project_root_markers=[]",
    // Native override keys split on dots; preserve the opaque path in a TOML value.
    // Hook commands still execute from the real workspace while its config is disabled.
    `projects={${workspaceTrustKey}={trust_level="untrusted"}}`,
    "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "sandbox_workspace_write.exclude_slash_tmp=true",
    "sandbox_workspace_write.network_access=false",
    "sandbox_workspace_write.writable_roots=[]",
  ]) {
    args = normalizeCodexAppServerArgs(args, override);
  }
  const writable = appServer.sandbox === "workspace-write" && sandbox.workspaceAccess === "rw";
  const sandboxPolicy: CodexSandboxPolicy = writable
    ? {
        type: "workspaceWrite",
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      }
    : { type: "readOnly", networkAccess: false };
  return {
    agentDir,
    cwd,
    sandboxPolicy,
    appServer: {
      ...appServer,
      // Explicit turn policy carries the permitted root without reopening project discovery.
      sessionRoot: undefined,
      sandbox: writable ? "workspace-write" : "read-only",
      // Pin user/custom home aliases without marking the default agent home as
      // externally owned: native artifact provisioning uses that distinction.
      start: {
        ...appServer.start,
        protectedLaunchRoots,
        cwd,
        args,
        ...(appServer.start.homeScope === "user" || appServer.start.env?.CODEX_HOME?.trim()
          ? { env: { ...appServer.start.env, CODEX_HOME: codexHome } }
          : {}),
      },
    } satisfies CodexAppServerRuntimeOptions,
  };
}
