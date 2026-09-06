import { isInternalMessageChannel } from "../utils/message-channel.js";
import { resolveInstallationTarget } from "./installation-target-context.js";

export type UpdateRequester = { channel?: string; accountId?: string; senderId?: string };
export type UpdateRequesterAuthority = Readonly<{
  requester: Readonly<UpdateRequester>;
  /** False means revoked; unavailable policy throws so the run records its actual failure. */
  isCurrent: () => boolean;
}>;

/** Only external chat requesters delegate command-owner authority to the updater. */
export function resolveManagedUpdateRequester(
  requester: UpdateRequester | undefined,
): UpdateRequester | undefined {
  return requester?.channel && !isInternalMessageChannel(requester.channel) ? requester : undefined;
}

export class UpdateRequesterRevokedError extends Error {
  readonly code = "requester-revoked";

  constructor() {
    super("requester-revoked");
    this.name = "UpdateRequesterRevokedError";
  }
}

/** Bind the admitted requester to fresh, read-only policy from its original installation. */
export async function createManagedUpdateRequesterAuthority(
  requester: UpdateRequester,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpdateRequesterAuthority> {
  const admittedRequester = Object.freeze({ ...requester });
  try {
    const authorityEnv = { ...env };
    const target = resolveInstallationTarget(authorityEnv);
    const [
      { isConfiguredCommandOwner },
      { readCurrentConfigForPolicyCheck },
      { ensureCliPluginRegistryLoaded },
    ] = await Promise.all([
      import("../auto-reply/command-auth.js"),
      import("../config/io.runtime.js"),
      import("../cli/plugin-registry-loader.js"),
    ]);
    const readCurrentConfig = () =>
      readCurrentConfigForPolicyCheck({
        env: authorityEnv,
        configPath: target.configPath,
      });
    await ensureCliPluginRegistryLoaded({
      scope: "configured-channels",
      routeLogsToStderr: true,
      config: readCurrentConfig(),
    });
    return Object.freeze({
      requester: admittedRequester,
      isCurrent: () => isConfiguredCommandOwner(readCurrentConfig(), admittedRequester),
    });
  } catch (error) {
    // Admission and worker startup precede run failure reporting. Surface failed
    // preparation at the authority check, inside the owning run's error boundary.
    return Object.freeze({
      requester: admittedRequester,
      isCurrent: () => {
        throw error;
      },
    });
  }
}
