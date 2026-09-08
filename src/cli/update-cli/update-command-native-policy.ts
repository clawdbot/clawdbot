import { execLaunchctl } from "../../daemon/launchd-exec.js";
import {
  resumeScheduledTaskAutoStartAfterUpdate,
  suspendScheduledTaskAutoStartForUpdate,
} from "../../daemon/schtasks-control.js";
import { execSystemctlUser } from "../../daemon/systemd-exec.js";
import type { UpdateRecoveryNativeIdentity } from "../../infra/update-run-recovery-native.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";

/** Dispatch only; the caller journals before this and independently reads back. */
export async function setUpdateCommandNativePolicy(
  identity: UpdateRecoveryNativeIdentity,
  enabled: boolean,
  env: NodeJS.ProcessEnv,
  assertCurrent: () => void,
  timeoutMs?: number,
): Promise<void> {
  assertCurrent();
  if (identity.platform === "darwin") {
    const result = await execLaunchctl(
      [enabled ? "enable" : "disable", `${identity.domain}/${identity.label}`],
      timeoutMs,
    );
    if (result.code !== 0 || result.termination !== "exit") {
      throw new Error("Native enable-policy command did not complete.");
    }
  } else if (identity.platform === "win32") {
    if (enabled) {
      await resumeScheduledTaskAutoStartAfterUpdate(env, { assertCurrent });
    } else {
      await suspendScheduledTaskAutoStartForUpdate(env, { assertCurrent, restoreOnFailure: false });
    }
  } else {
    if (identity.scope !== "user") {
      throw new UpdateCommandRecoveryPendingError(
        "System manager restoration is unavailable to this owner.",
      );
    }
    const result = await execSystemctlUser(
      env,
      [enabled ? "enable" : "disable", identity.unitName],
      timeoutMs,
      assertCurrent,
    );
    if (result.code !== 0 || result.termination !== "exit") {
      throw new Error("Native enable-policy command did not complete.");
    }
  }
  assertCurrent();
}
