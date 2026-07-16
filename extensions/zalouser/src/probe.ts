import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
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
    const user = timeoutMs
      ? await Promise.race([
          getZaloUserInfo(profile),
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), Math.max(timeoutMs, 1000)),
          ),
        ])
      : await getZaloUserInfo(profile);

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
