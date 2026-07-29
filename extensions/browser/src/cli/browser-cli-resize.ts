/**
 * Shared Browser CLI resize runner used by resize and set viewport commands.
 */
import { ACT_MAX_VIEWPORT_DIMENSION } from "../browser/act-policy.js";
import { callBrowserResize, type BrowserParentOpts } from "./browser-cli-shared.js";
import { danger, defaultRuntime } from "./core-api.js";

/** Validates viewport dimensions, sends resize action, and writes CLI output. */
export async function runBrowserResizeWithOutput(params: {
  parent: BrowserParentOpts;
  profile?: string;
  width: number;
  height: number;
  targetId?: string;
  timeoutMs?: number;
  successMessage: string;
}): Promise<void> {
  const { width, height } = params;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    defaultRuntime.error(danger("width and height must be numbers"));
    defaultRuntime.exit(1);
    return;
  }
  if (width > ACT_MAX_VIEWPORT_DIMENSION || height > ACT_MAX_VIEWPORT_DIMENSION) {
    defaultRuntime.error(danger(`width and height must not exceed ${ACT_MAX_VIEWPORT_DIMENSION}`));
    defaultRuntime.exit(1);
    return;
  }

  const result = await callBrowserResize(
    params.parent,
    {
      profile: params.profile,
      width,
      height,
      targetId: params.targetId,
    },
    { timeoutMs: params.timeoutMs ?? 20000 },
  );

  if (params.parent?.json) {
    defaultRuntime.writeJson(result);
    return;
  }
  defaultRuntime.log(params.successMessage);
}
