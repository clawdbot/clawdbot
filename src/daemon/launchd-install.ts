/** Transactional LaunchAgent installation, staging, rollback, and removal. */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveLegacyGatewayLaunchAgentLabels } from "./constants.js";
import { isCurrentProcessInsideLaunchdService } from "./launchd-current-service.js";
import {
  execLaunchctl,
  formatLaunchctlResultDetail,
  isLaunchctlNotLoaded,
} from "./launchd-exec.js";
import { assertValidLaunchAgentLabel, resolveLaunchAgentLabel } from "./launchd-label.js";
import {
  bootstrapLaunchAgentOrThrow,
  probeLaunchAgentState,
  resolveLaunchAgentGuiDomain,
} from "./launchd-runtime.js";
import {
  LAUNCH_AGENT_ENV_FILE_MODE,
  LAUNCH_AGENT_ENV_WRAPPER_MODE,
  LAUNCH_AGENT_PLIST_MODE,
  publishLaunchAgentPlist,
  readExistingLaunchAgentPlist,
  resolveLaunchAgentEnvFilePath,
  resolveLaunchAgentEnvWrapperPath,
  resolveLaunchAgentPlistPath,
  resolveLaunchAgentPlistPathForLabel,
  writeLaunchAgentPlist,
} from "./launchd-service-files.js";
import { assertNoSystemLaunchDaemonOwnership } from "./launchd-system.js";
import { formatLine, normalizeWindowsPathSeparators, writeFormattedLines } from "./output.js";
import { resolveDaemonHomeDir } from "./paths.js";
import type {
  GatewayServiceEnv,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
} from "./service-types.js";

export async function uninstallLaunchAgent({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<void> {
  await assertExternalLaunchAgentMutation(env, "uninstall");
  const domain = resolveLaunchAgentGuiDomain();
  const label = resolveLaunchAgentLabel(env);
  const plistPath = resolveLaunchAgentPlistPath(env);
  const probe = await probeLaunchAgentState(`${domain}/${label}`);
  if (probe.state !== "not-loaded") {
    const bootout = await execLaunchctl(["bootout", domain, plistPath]);
    if (bootout.code !== 0 && !isLaunchctlNotLoaded(bootout)) {
      throw new Error(`launchctl bootout failed: ${formatLaunchctlResultDetail(bootout)}`);
    }
  }

  try {
    await fs.lstat(plistPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw createLaunchAgentRemovalError(error);
    }
    stdout.write(`LaunchAgent not found at ${plistPath}\n`);
    return;
  }

  const home = normalizeWindowsPathSeparators(resolveDaemonHomeDir(env));
  const trashDir = path.posix.join(home, ".Trash");
  const dest = path.join(trashDir, `${label}.plist`);
  try {
    await fs.mkdir(trashDir, { recursive: true });
    await fs.rename(plistPath, dest);
    stdout.write(`${formatLine("Moved LaunchAgent to Trash", dest)}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        await fs.lstat(plistPath);
      } catch (accessError) {
        if ((accessError as NodeJS.ErrnoException).code === "ENOENT") {
          stdout.write(`LaunchAgent not found at ${plistPath}\n`);
          return;
        }
        throw createLaunchAgentRemovalError(accessError);
      }
    }
    throw createLaunchAgentRemovalError(error);
  }
}

function createLaunchAgentRemovalError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;
  return new Error(
    `LaunchAgent removal failed${code ? ` (${code})` : ""}. Check permissions and retry.`,
  );
}
async function currentGatewayLaunchAgentLabel(
  targetEnv: Record<string, string | undefined>,
): Promise<string | undefined> {
  const configuredCurrentLabel = process.env.OPENCLAW_LAUNCHD_LABEL?.trim();
  const candidates = new Set([
    resolveLaunchAgentLabel(targetEnv),
    ...(configuredCurrentLabel ? [assertValidLaunchAgentLabel(configuredCurrentLabel)] : []),
  ]);
  for (const label of candidates) {
    if (await isCurrentProcessInsideLaunchdService(label, process.env)) {
      return label;
    }
  }
  return undefined;
}

async function assertExternalLaunchAgentMutation(
  env: Record<string, string | undefined>,
  action: "install" | "uninstall",
): Promise<void> {
  const currentLabel = await currentGatewayLaunchAgentLabel(env);
  if (!currentLabel) {
    return;
  }
  throw new Error(
    `Refusing to ${action} LaunchAgent ${resolveLaunchAgentLabel(env)} from inside ${currentLabel}; run this command from an external shell.`,
  );
}

export async function stageLaunchAgent({
  stdout,
  ...args
}: GatewayServiceInstallArgs): Promise<{ plistPath: string }> {
  const { plistPath, stdoutPath } = await writeLaunchAgentPlist({ ...args, stdout });
  writeFormattedLines(
    stdout,
    [
      { label: "Staged LaunchAgent", value: plistPath },
      { label: "Logs", value: stdoutPath },
    ],
    { leadingBlankLine: true },
  );
  return { plistPath };
}

type LaunchAgentInstallSnapshot = {
  plistContents: Buffer | null;
  envFileContents: Buffer | null;
  wrapperContents: Buffer | null;
  legacy: Array<{
    label: string;
    plistPath: string;
    contents: Buffer | null;
    loaded: boolean;
  }>;
  loaded: boolean;
};

async function snapshotLaunchAgentLoadedState(
  plistContents: Buffer | null,
  serviceTarget: string,
): Promise<boolean> {
  const probe = await probeLaunchAgentState(serviceTarget);
  if (probe.state === "unknown") {
    throw new Error(
      `launchctl print could not determine whether ${serviceTarget} is loaded: ${probe.detail ?? "unknown error"}`,
    );
  }
  const loaded = probe.state !== "not-loaded";
  if (loaded && plistContents === null) {
    // launchd can retain a definition after its plist is deleted. Booting that
    // job out would destroy the only copy, so no exact rollback is possible.
    throw new Error(
      `LaunchAgent ${serviceTarget} is loaded but its plist is missing; refusing an install that cannot restore the current definition if activation fails.`,
    );
  }
  return loaded;
}

async function restoreLaunchAgentOwnedFile(params: {
  path: string;
  contents: Buffer | null;
  mode: number;
}): Promise<void> {
  if (params.contents === null) {
    await fs.unlink(params.path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    });
    return;
  }
  const temporaryPath = `${params.path}.openclaw-${randomUUID()}.rollback`;
  try {
    await fs.writeFile(temporaryPath, params.contents.toString("utf8"), {
      flag: "wx",
      mode: params.mode,
    });
    await fs.rename(temporaryPath, params.path);
    await fs.chmod(params.path, params.mode).catch(() => undefined);
  } finally {
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

async function restoreLaunchAgentInstallArtifacts(params: {
  env: GatewayServiceEnv;
  label: string;
  plistPath: string;
  snapshot: LaunchAgentInstallSnapshot;
}): Promise<void> {
  await restoreLaunchAgentOwnedFile({
    path: resolveLaunchAgentEnvFilePath(params.env, params.label),
    contents: params.snapshot.envFileContents,
    mode: LAUNCH_AGENT_ENV_FILE_MODE,
  });
  await restoreLaunchAgentOwnedFile({
    path: resolveLaunchAgentEnvWrapperPath(params.env, params.label),
    contents: params.snapshot.wrapperContents,
    mode: LAUNCH_AGENT_ENV_WRAPPER_MODE,
  });
  for (const legacy of params.snapshot.legacy) {
    await restoreLaunchAgentOwnedFile({
      path: legacy.plistPath,
      contents: legacy.contents,
      mode: LAUNCH_AGENT_PLIST_MODE,
    });
  }
  if (params.snapshot.plistContents === null) {
    await fs.unlink(params.plistPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    });
    return;
  }
  await publishLaunchAgentPlist({
    label: params.label,
    plistPath: params.plistPath,
    contents: params.snapshot.plistContents.toString("utf8"),
  });
}

async function restoreLaunchAgentInstall(params: {
  domain: string;
  env: GatewayServiceEnv;
  label: string;
  plistPath: string;
  snapshot: LaunchAgentInstallSnapshot;
}): Promise<void> {
  const serviceTarget = `${params.domain}/${params.label}`;
  // A failed bootstrap may leave no registered job. Restore files directly in
  // that state; only a loaded replacement must be removed before rollback.
  const currentState = await probeLaunchAgentState(serviceTarget);
  if (currentState.state === "unknown") {
    throw new Error(
      `launchctl print could not determine whether ${serviceTarget} is loaded during LaunchAgent rollback: ${currentState.detail ?? "unknown error"}`,
    );
  }
  if (currentState.state !== "not-loaded") {
    const bootout = await execLaunchctl(["bootout", serviceTarget]);
    if (bootout.code !== 0 && !isLaunchctlNotLoaded(bootout)) {
      throw new Error(`launchctl bootout failed: ${formatLaunchctlResultDetail(bootout)}`);
    }
  }
  await restoreLaunchAgentInstallArtifacts({
    env: params.env,
    label: params.label,
    plistPath: params.plistPath,
    snapshot: params.snapshot,
  });
  if (params.snapshot.loaded && params.snapshot.plistContents !== null) {
    await bootstrapLaunchAgentOrThrow({
      domain: params.domain,
      serviceTarget,
      plistPath: params.plistPath,
      actionHint: "openclaw gateway start",
      retryPendingTeardown: true,
    });
  }
  for (const legacy of params.snapshot.legacy) {
    if (!legacy.loaded || legacy.contents === null) {
      continue;
    }
    await bootstrapLaunchAgentOrThrow({
      domain: params.domain,
      serviceTarget: `${params.domain}/${legacy.label}`,
      plistPath: legacy.plistPath,
      actionHint: "openclaw gateway start",
      retryPendingTeardown: true,
    });
  }
}

async function deactivateLaunchAgentDefinition(domain: string, plistPath: string): Promise<void> {
  for (const args of [
    ["bootout", domain, plistPath],
    ["unload", plistPath],
  ]) {
    const result = await execLaunchctl(args);
    if (result.code !== 0 && !isLaunchctlNotLoaded(result)) {
      throw new Error(
        `launchctl ${args[0]} failed during LaunchAgent install: ${formatLaunchctlResultDetail(result)}`,
      );
    }
  }
}

async function activateLaunchAgent(params: {
  env: GatewayServiceEnv;
  plistPath: string;
  snapshot: LaunchAgentInstallSnapshot;
}) {
  const domain = resolveLaunchAgentGuiDomain();
  const label = resolveLaunchAgentLabel(params.env);
  try {
    // Recheck immediately before activation so a system daemon installed after
    // the plist write cannot race us into two KeepAlive managers.
    await assertNoSystemLaunchDaemonOwnership(label);
    for (const legacy of params.snapshot.legacy) {
      if (legacy.loaded) {
        await deactivateLaunchAgentDefinition(domain, legacy.plistPath);
      }
    }
    // Plist-form bootout reports EIO for a valid definition that was never loaded.
    // The pre-publication snapshot is the authoritative cutover fact.
    if (params.snapshot.loaded) {
      await deactivateLaunchAgentDefinition(domain, params.plistPath);
    }
    // launchd can persist "disabled" state even after bootout + plist removal; clear it before bootstrap.
    await bootstrapLaunchAgentOrThrow({
      domain,
      serviceTarget: `${domain}/${label}`,
      plistPath: params.plistPath,
      actionHint: "openclaw gateway install --force",
      retryPendingTeardown: true,
    });
    for (const legacy of params.snapshot.legacy) {
      await fs.unlink(legacy.plistPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      });
    }
  } catch (error) {
    try {
      await restoreLaunchAgentInstall({
        domain,
        env: params.env,
        label,
        plistPath: params.plistPath,
        snapshot: params.snapshot,
      });
    } catch (rollbackError) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${detail}\nThe previous LaunchAgent supervision could not be restored.`, {
        cause: rollbackError,
      });
    }
    throw error;
  }
}

export async function installLaunchAgent(
  args: GatewayServiceInstallArgs,
): Promise<{ plistPath: string }> {
  await assertExternalLaunchAgentMutation(args.env, "install");
  const targetPlistPath = resolveLaunchAgentPlistPath(args.env);
  const previousContents = await readExistingLaunchAgentPlist(targetPlistPath);
  const label = resolveLaunchAgentLabel(args.env);
  const domain = resolveLaunchAgentGuiDomain();
  // Plist, generated environment files, and launchd registration form one cutover.
  // Capture every prior owner before publication so any later failure can restore it.
  const legacy = await Promise.all(
    resolveLegacyGatewayLaunchAgentLabels(args.env.OPENCLAW_PROFILE).map(async (legacyLabel) => {
      const plistPath = resolveLaunchAgentPlistPathForLabel(args.env, legacyLabel);
      const contents = await readExistingLaunchAgentPlist(plistPath);
      return {
        label: legacyLabel,
        plistPath,
        contents,
        loaded: await snapshotLaunchAgentLoadedState(contents, `${domain}/${legacyLabel}`),
      };
    }),
  );
  const snapshot: LaunchAgentInstallSnapshot = {
    plistContents: previousContents,
    envFileContents: await readExistingLaunchAgentPlist(
      resolveLaunchAgentEnvFilePath(args.env, label),
    ),
    wrapperContents: await readExistingLaunchAgentPlist(
      resolveLaunchAgentEnvWrapperPath(args.env, label),
    ),
    legacy,
    loaded: await snapshotLaunchAgentLoadedState(previousContents, `${domain}/${label}`),
  };
  let plistPath: string;
  let stdoutPath: string;
  try {
    ({ plistPath, stdoutPath } = await writeLaunchAgentPlist(args));
  } catch (error) {
    try {
      await restoreLaunchAgentInstallArtifacts({
        env: args.env,
        label,
        plistPath: targetPlistPath,
        snapshot,
      });
    } catch (rollbackError) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${detail}\nThe previous LaunchAgent files could not be restored.`, {
        cause: rollbackError,
      });
    }
    throw error;
  }
  await activateLaunchAgent({
    env: args.env,
    plistPath,
    snapshot,
  });
  // `bootstrap` already loads RunAtLoad agents. Avoid `kickstart -k` here:
  // on slow macOS guests it SIGTERMs the freshly booted gateway and pushes the
  // real listener startup past setup's health deadline.
  writeFormattedLines(
    args.stdout,
    [
      { label: "Installed LaunchAgent", value: plistPath },
      { label: "Logs", value: stdoutPath },
    ],
    { leadingBlankLine: true },
  );
  return { plistPath };
}
