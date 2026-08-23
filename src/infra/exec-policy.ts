import type { ExecAsk, ExecMode, ExecSecurity } from "./exec-approvals.js";
import { resolveExecPolicyForMode } from "./exec-approvals.js";

type ExecPolicyLayer = {
  mode?: ExecMode;
  security?: ExecSecurity;
  ask?: ExecAsk;
};

export function applyExecPolicyLayer<TBase extends ExecPolicyLayer>(
  base: TBase,
  layer?: ExecPolicyLayer,
): TBase & ExecPolicyLayer {
  if (!layer) {
    return base;
  }
  if (layer.mode) {
    return {
      ...base,
      mode: layer.mode,
      ...resolveExecPolicyForMode(layer.mode),
    } as unknown as TBase & ExecPolicyLayer;
  }
  if (layer.security !== undefined || layer.ask !== undefined) {
    const { mode: _mode, ...baseWithoutMode } = base;
    return {
      ...baseWithoutMode,
      security: layer.security ?? base.security,
      ask: layer.ask ?? base.ask,
    } as unknown as TBase & ExecPolicyLayer;
  }
  return base;
}
