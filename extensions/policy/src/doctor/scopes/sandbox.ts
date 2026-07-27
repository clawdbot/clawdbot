// Policy doctor health-check factories for one policy scope.
import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { CHECK_IDS } from "../check-ids.js";
import type { PolicyDoctorCheckDeps } from "../types.js";

export function createPolicySandboxChecks(deps: PolicyDoctorCheckDeps): readonly HealthCheck[] {
  const { evaluatePolicy, findingsForCheck } = deps;

  const policySandboxModeUnapprovedCheck: HealthCheck = {
    id: CHECK_IDS.policySandboxModeUnapproved,
    kind: "plugin",
    description: "Sandbox mode config satisfies policy requirements.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policySandboxModeUnapproved);
    },
  };
  const policySandboxBackendUnapprovedCheck: HealthCheck = {
    id: CHECK_IDS.policySandboxBackendUnapproved,
    kind: "plugin",
    description: "Sandbox backend config satisfies policy requirements.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policySandboxBackendUnapproved);
    },
  };
  const policySandboxContainerPostureUnobservableCheck: HealthCheck = {
    id: CHECK_IDS.policySandboxContainerPostureUnobservable,
    kind: "plugin",
    description: "Sandbox container posture policy only targets observable container backends.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(
        await evaluatePolicy(ctx),
        CHECK_IDS.policySandboxContainerPostureUnobservable,
      );
    },
  };
  const policySandboxContainerHostNetworkDeniedCheck: HealthCheck = {
    id: CHECK_IDS.policySandboxContainerHostNetworkDenied,
    kind: "plugin",
    description: "Sandbox container config avoids host network mode.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(
        await evaluatePolicy(ctx),
        CHECK_IDS.policySandboxContainerHostNetworkDenied,
      );
    },
  };
  const policySandboxContainerNamespaceJoinDeniedCheck: HealthCheck = {
    id: CHECK_IDS.policySandboxContainerNamespaceJoinDenied,
    kind: "plugin",
    description: "Sandbox container config avoids joining another container network namespace.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(
        await evaluatePolicy(ctx),
        CHECK_IDS.policySandboxContainerNamespaceJoinDenied,
      );
    },
  };
  const policySandboxContainerMountModeRequiredCheck: HealthCheck = {
    id: CHECK_IDS.policySandboxContainerMountModeRequired,
    kind: "plugin",
    description: "Sandbox container mounts are read-only when policy requires it.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(
        await evaluatePolicy(ctx),
        CHECK_IDS.policySandboxContainerMountModeRequired,
      );
    },
  };
  const policySandboxContainerRuntimeSocketMountCheck: HealthCheck = {
    id: CHECK_IDS.policySandboxContainerRuntimeSocketMount,
    kind: "plugin",
    description: "Sandbox container mounts avoid host container runtime sockets.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(
        await evaluatePolicy(ctx),
        CHECK_IDS.policySandboxContainerRuntimeSocketMount,
      );
    },
  };
  const policySandboxContainerUnconfinedProfileCheck: HealthCheck = {
    id: CHECK_IDS.policySandboxContainerUnconfinedProfile,
    kind: "plugin",
    description: "Sandbox container profile config avoids unconfined profiles.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(
        await evaluatePolicy(ctx),
        CHECK_IDS.policySandboxContainerUnconfinedProfile,
      );
    },
  };
  const policySandboxBrowserCdpSourceRangeMissingCheck: HealthCheck = {
    id: CHECK_IDS.policySandboxBrowserCdpSourceRangeMissing,
    kind: "plugin",
    description: "Sandbox browser CDP config includes a source range when policy requires it.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(
        await evaluatePolicy(ctx),
        CHECK_IDS.policySandboxBrowserCdpSourceRangeMissing,
      );
    },
  };

  return [
    policySandboxModeUnapprovedCheck,
    policySandboxBackendUnapprovedCheck,
    policySandboxContainerPostureUnobservableCheck,
    policySandboxContainerHostNetworkDeniedCheck,
    policySandboxContainerNamespaceJoinDeniedCheck,
    policySandboxContainerMountModeRequiredCheck,
    policySandboxContainerRuntimeSocketMountCheck,
    policySandboxContainerUnconfinedProfileCheck,
    policySandboxBrowserCdpSourceRangeMissingCheck,
  ];
}
