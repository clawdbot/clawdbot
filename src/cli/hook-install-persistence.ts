// CLI persistence for hook-pack installs.
import { replaceConfigFile } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type HookInstallUpdate, recordHookInstall } from "../hooks/installs.js";
import type { ConfigSnapshotForInstallPersist } from "../plugins/install-persistence.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { enableInternalHookEntries, logHookPackRestartHint } from "./plugins-command-helpers.js";

export async function persistHookPackInstall(params: {
  snapshot: ConfigSnapshotForInstallPersist;
  hookPackId: string;
  hooks: string[];
  install: Omit<HookInstallUpdate, "hookId" | "hooks">;
  successMessage?: string;
  runtime?: RuntimeEnv;
}): Promise<OpenClawConfig> {
  const runtime = params.runtime ?? defaultRuntime;
  let next = enableInternalHookEntries(params.snapshot.config, params.hooks);
  next = recordHookInstall(next, {
    hookId: params.hookPackId,
    hooks: params.hooks,
    ...params.install,
  });
  await replaceConfigFile({
    nextConfig: next,
    baseHash: params.snapshot.baseHash,
    writeOptions: params.snapshot.writeOptions,
  });
  runtime.log(params.successMessage ?? `Installed hook pack: ${params.hookPackId}`);
  logHookPackRestartHint(runtime);
  return next;
}
