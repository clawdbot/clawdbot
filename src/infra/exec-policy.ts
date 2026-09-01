import type { ExecAsk, ExecMode, ExecSecurity } from "./exec-approvals.js";
import { resolveExecPolicyForMode } from "./exec-approvals.js";

type ExecPolicyLayer = {
  mode?: ExecMode;
  security?: ExecSecurity;
  ask?: ExecAsk;
};

type RequiredExecPolicy = Required<Pick<ExecPolicyLayer, "security" | "ask">>;

export function applyExecPolicyLayer<TBase extends ExecPolicyLayer & RequiredExecPolicy>(
  base: TBase,
  layer?: ExecPolicyLayer,
): Omit<TBase, keyof ExecPolicyLayer> & ExecPolicyLayer & RequiredExecPolicy;
export function applyExecPolicyLayer<TBase extends ExecPolicyLayer>(
  base: TBase,
  layer?: ExecPolicyLayer,
): Omit<TBase, keyof ExecPolicyLayer> & ExecPolicyLayer;
export function applyExecPolicyLayer(
  base: ExecPolicyLayer,
  layer?: ExecPolicyLayer,
): ExecPolicyLayer {
  if (!layer) {
    return base;
  }
  if (layer.mode) {
    return {
      ...base,
      mode: layer.mode,
      ...resolveExecPolicyForMode(layer.mode),
    };
  }
  if (layer.security !== undefined || layer.ask !== undefined) {
    const { mode: _mode, ...baseWithoutMode } = base;
    return {
      ...baseWithoutMode,
      security: layer.security ?? base.security,
      ask: layer.ask ?? base.ask,
    };
  }
  return base;
}
