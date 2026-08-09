import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { QaSuiteRunParams } from "./suite-types.js";

export type QaSuiteConfigMutation = (cfg: OpenClawConfig) => OpenClawConfig;

type QaSuiteRunParamsWithConfigMutation = QaSuiteRunParams & {
  qaSuiteConfigMutation?: QaSuiteConfigMutation;
};

export function withQaSuiteConfigMutation(
  params: QaSuiteRunParams,
  mutation: QaSuiteConfigMutation | undefined,
): QaSuiteRunParams {
  return mutation ? { ...params, qaSuiteConfigMutation: mutation } : params;
}

export function getQaSuiteConfigMutation(
  params: QaSuiteRunParams | undefined,
): QaSuiteConfigMutation | undefined {
  return (params as QaSuiteRunParamsWithConfigMutation | undefined)?.qaSuiteConfigMutation;
}
