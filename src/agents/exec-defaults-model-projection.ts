import { resolveExecModePolicy, type ExecTarget } from "../infra/exec-approvals-core.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";

export type ModelExecTargetProjection = {
  targets: readonly ExecTarget[];
  elevated: "hidden" | "boolean" | "optional-true" | "required-true";
};

/**
 * Resolves the model-visible exec surface from prepared, process-static policy.
 * Mutable approval files and endpoint reachability remain execution-time checks.
 */
export function resolveModelExecTargetProjection(
  defaults?: Pick<ExecToolDefaults, "host" | "sandbox" | "elevated" | "mode" | "security" | "ask">,
): ModelExecTargetProjection | undefined {
  const modePolicy = resolveExecModePolicy({
    mode: defaults?.mode,
    security: defaults?.security ?? "full",
    ask: defaults?.ask ?? "off",
  });
  if (modePolicy.security === "deny") {
    return undefined;
  }

  const configuredTarget = defaults?.host ?? "auto";
  const sandboxAvailable = Boolean(defaults?.sandbox);
  const elevatedAvailable = Boolean(defaults?.elevated?.enabled && defaults.elevated.allowed);
  const elevated = elevatedAvailable ? "boolean" : "hidden";
  if (configuredTarget === "auto") {
    return {
      targets: sandboxAvailable ? ["auto", "sandbox"] : ["auto", "gateway", "node"],
      elevated,
    };
  }
  if (configuredTarget !== "sandbox" || sandboxAvailable) {
    return { targets: [configuredTarget], elevated };
  }
  if (!elevatedAvailable) {
    return undefined;
  }
  return {
    targets: ["sandbox"],
    elevated: defaults?.elevated?.defaultLevel === "off" ? "required-true" : "optional-true",
  };
}
