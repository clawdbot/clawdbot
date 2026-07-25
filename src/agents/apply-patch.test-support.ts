import type { ApplyPatchSummary } from "./apply-patch.js";
import "./apply-patch.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

type ApplyPatchOptions = {
  cwd: string;
  sandbox?: { root: string; bridge: SandboxFsBridge };
  workspaceOnly?: boolean;
  signal?: AbortSignal;
};

type ApplyPatchResult = {
  summary: ApplyPatchSummary;
  text: string;
  noOp?: boolean;
};

type ApplyPatchTestApi = {
  applyPatch(input: string, options: ApplyPatchOptions): Promise<ApplyPatchResult>;
};

function getTestApi(): ApplyPatchTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.applyPatchTestApi")
  ];
  if (!api) {
    throw new Error("apply patch test API is unavailable");
  }
  return api as ApplyPatchTestApi;
}

export async function applyPatch(
  input: string,
  options: ApplyPatchOptions,
): Promise<ApplyPatchResult> {
  return await getTestApi().applyPatch(input, options);
}
