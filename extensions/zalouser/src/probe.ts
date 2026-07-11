// Zalouser plugin module implements probe behavior.
import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import type { ZcaUserInfo } from "./types.js";
import { getZaloUserInfo } from "./zalo-js.js";

export type ZalouserProbeResult = BaseProbeResult<string> & {
  user?: ZcaUserInfo;
};

export async function probeZalouser(
  profile: string,
  timeoutMs?: number,
): Promise<ZalouserProbeResult> {
  try {
    let user: ZcaUserInfo | null;
    if (timeoutMs) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        user = await Promise.race([
          getZaloUserInfo(profile),
          new Promise<null>((resolve) => {
            timeout = setTimeout(() => resolve(null), resolveTimerTimeoutMs(timeoutMs, 1000, 1000));
          }),
        ]);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
    } else {
      user = await getZaloUserInfo(profile);
    }

    if (!user) {
      return { ok: false, error: "Not authenticated" };
    }

    return { ok: true, user };
  } catch (error) {
    return {
      ok: false,
      error: formatErrorMessage(error),
    };
  }
}
