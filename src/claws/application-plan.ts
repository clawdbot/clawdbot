import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { inspectModelReference } from "../commands/models/model-reference-validation.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ClawAddCapabilityChange,
  ClawAddPlanAction,
  ClawDiagnostic,
  ClawExtensionPlan,
  ClawLocalPrerequisite,
  ClawOpenClawExtension,
  ClawOpenClawProfile,
  ClawPackage,
  ClawPackagePreflight,
  ClawPackagePreflightResult,
} from "./types.js";

export function clawAddCapabilityChange(
  change: Omit<ClawAddCapabilityChange, "classification" | "requiresDistinctConsent" | "digest">,
): ClawAddCapabilityChange {
  return {
    ...change,
    classification: "escalation",
    requiresDistinctConsent: true,
    digest: `sha256:${createHash("sha256").update(stableStringify(change.effect)).digest("hex")}`,
  };
}

export function clawAgentCapabilityChange(
  agentId: string,
  settings: ClawOpenClawProfile["agent"],
): ClawAddCapabilityChange | undefined {
  const effect = {
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.subagents ? { subagents: settings.subagents } : {}),
    ...(settings.sandbox ? { sandbox: settings.sandbox } : {}),
    ...(settings.tools ? { tools: settings.tools } : {}),
    ...(settings.memory ? { memory: settings.memory } : {}),
    ...(settings.heartbeat ? { heartbeat: settings.heartbeat } : {}),
  };
  if (Object.keys(effect).length === 0) {
    return undefined;
  }
  return clawAddCapabilityChange({
    kind: "agent",
    id: agentId,
    path: "agent",
    action: "create",
    reason:
      settings.model || settings.subagents
        ? "The new agent declares model, delegation, sandbox, tool, memory-search, or recurring heartbeat configuration."
        : "The new agent declares sandbox, tool, memory-search, or recurring heartbeat capabilities.",
    effect,
  });
}

export function clawAgentConfigurationNotices(
  agent: ClawOpenClawProfile["agent"],
  config: OpenClawConfig,
  agentIds: ReadonlySet<string>,
): ClawDiagnostic[] {
  const notices: ClawDiagnostic[] = [];
  const notice = (code: string, path: string, message: string) => {
    notices.push({
      level: "warning",
      phase: "plan",
      code,
      path: `$.profiles.openclaw.agent.${path}`,
      message,
    });
  };
  for (const [index, target] of (agent.subagents?.allowAgents ?? []).entries()) {
    if (!agentIds.has(target)) {
      notice(
        "delegation_target_unresolved",
        `subagents.allowAgents[${index}]`,
        `Delegation target ${JSON.stringify(target)} is not in the local agent roster; it will be applied as declared. Install that agent before delegating to it.`,
      );
    }
  }
  const refs = agent.model ? [agent.model.primary, ...(agent.model.fallbacks ?? [])] : [];
  for (const [index, ref] of refs.entries()) {
    const slash = ref.indexOf("/");
    const inspection = inspectModelReference({
      cfg: config,
      ref: { provider: ref.slice(0, slash), model: ref.slice(slash + 1) },
    });
    if (inspection.status !== "known") {
      notice(
        "model_not_in_catalog",
        index === 0 ? "model.primary" : `model.fallbacks[${index - 1}]`,
        `Model ${JSON.stringify(ref)} is not in the local model catalog; it will be applied as declared. Configure it before running the agent.`,
      );
    }
  }
  return notices;
}

export function clawProfileExtensionPackages(
  profile: ClawOpenClawProfile | undefined,
): ClawPackage[] {
  return (profile?.extensions ?? []).map((extension) => ({
    kind: "plugin",
    source: extension.source,
    ref: extension.ref,
    version: extension.version,
  }));
}

function blocker(code: string, path: string, message: string): ClawDiagnostic {
  return { level: "error", code, phase: "plan", path, message };
}

export function findClawExtensionPackageCollisions(params: {
  packages: ClawPackage[];
  extensions: ClawOpenClawExtension[];
}): Array<{ index: number; diagnostic: ClawDiagnostic }> {
  const declaredPackageIds = new Set(params.packages.map((pkg) => `${pkg.kind}:${pkg.ref}`));
  const collisions: Array<{ index: number; diagnostic: ClawDiagnostic }> = [];

  for (const [index, extension] of params.extensions.entries()) {
    const packageId = `plugin:${extension.ref}`;
    if (declaredPackageIds.has(packageId)) {
      collisions.push({
        index,
        diagnostic: blocker(
          "extension_package_collision",
          `$.profiles.openclaw.extensions[${index}]`,
          `Extension package ${JSON.stringify(packageId)} is already declared by the portable manifest or another profile extension.`,
        ),
      });
      continue;
    }
    declaredPackageIds.add(packageId);
  }

  return collisions;
}

function extensionCapabilityChange(params: {
  extension: ClawOpenClawExtension;
  preflight: ClawPackagePreflightResult;
}): ClawAddCapabilityChange {
  const effect = {
    id: params.extension.id,
    source: params.extension.source,
    ref: params.extension.ref,
    version: params.extension.version,
    expectedFormat: params.extension.format,
    detectedFormat: params.preflight.detectedFormat ?? "unresolved",
    integrity: params.preflight.integrity ?? "unresolved",
    mapped: params.preflight.mapped ?? [],
    unavailable: params.preflight.unavailable ?? [],
    adapterIdentity: params.preflight.adapterIdentity ?? "unresolved",
    ...(params.preflight.installId ? { installId: params.preflight.installId } : {}),
    ...(params.preflight.warning ? { riskWarning: params.preflight.warning } : {}),
  };
  const change = {
    kind: "package" as const,
    id: `extension:${params.extension.id}`,
    path: `openclaw.extensions.${params.extension.id}`,
    action: params.preflight.action === "reuse" ? ("reuse" as const) : ("install" as const),
    reason:
      params.preflight.action === "reuse"
        ? "The OpenClaw profile requires access to an existing native extension."
        : "The OpenClaw profile requires installation of native extension content or executable code.",
    effect,
  };
  return clawAddCapabilityChange(change);
}

export async function planClawExtensions(params: {
  extensions: ClawOpenClawExtension[];
  workspace: string;
  packagePreflight?: ClawPackagePreflight;
}): Promise<{
  extensions: ClawExtensionPlan[];
  actions: ClawAddPlanAction[];
  capabilityChanges: ClawAddCapabilityChange[];
  requirements: ClawLocalPrerequisite[];
  blockers: ClawDiagnostic[];
}> {
  const extensions: ClawExtensionPlan[] = [];
  const actions: ClawAddPlanAction[] = [];
  const capabilityChanges: ClawAddCapabilityChange[] = [];
  const requirements: ClawLocalPrerequisite[] = [];
  const blockers: ClawDiagnostic[] = [];

  for (const [index, extension] of params.extensions.entries()) {
    const preflight: ClawPackagePreflightResult = params.packagePreflight
      ? await params.packagePreflight(
          {
            kind: "plugin",
            source: extension.source,
            ref: extension.ref,
            version: extension.version,
          },
          params.workspace,
        )
      : {
          ok: false as const,
          code: "package_install_unavailable",
          message: "Extension preflight is unavailable.",
        };
    const completeProvenance =
      preflight.ok &&
      Boolean(
        preflight.integrity &&
        preflight.installId &&
        preflight.action &&
        preflight.detectedFormat &&
        preflight.adapterIdentity,
      );
    const incompleteProvenance =
      preflight.ok && !completeProvenance
        ? blocker(
            "extension_provenance_incomplete",
            `$.profiles.openclaw.extensions[${index}]`,
            `Extension ${JSON.stringify(extension.id)} did not resolve complete canonical identity and adapter provenance.`,
          )
        : undefined;
    const formatMismatch =
      preflight.ok && completeProvenance && preflight.detectedFormat !== extension.format
        ? blocker(
            "extension_format_mismatch",
            `$.profiles.openclaw.extensions[${index}].format`,
            `Extension ${JSON.stringify(extension.id)} declares format ${JSON.stringify(extension.format)}, but the canonical plugin detector found ${JSON.stringify(preflight.detectedFormat ?? "unknown")}.`,
          )
        : undefined;
    const diagnostic = !preflight.ok
      ? blocker(
          preflight.code ?? "extension_preflight_failed",
          `$.profiles.openclaw.extensions[${index}]`,
          preflight.message ?? "Extension preflight failed.",
        )
      : (incompleteProvenance ?? formatMismatch);
    if (diagnostic) {
      blockers.push(diagnostic);
    }
    if (preflight.ok && preflight.requirements) {
      requirements.push(...preflight.requirements);
    }
    const requirementState: ClawExtensionPlan["requirementState"] = diagnostic
      ? "conflicting"
      : preflight.action === "install"
        ? "missing-installable"
        : preflight.requirements && preflight.requirements.length > 0
          ? "setup-required"
          : "satisfied";
    const extensionPlan: ClawExtensionPlan = {
      ...extension,
      ...(preflight.detectedFormat ? { detectedFormat: preflight.detectedFormat } : {}),
      ...(preflight.integrity ? { integrity: preflight.integrity } : {}),
      ...(preflight.installId ? { installId: preflight.installId } : {}),
      ...(preflight.action ? { ownerAction: preflight.action } : {}),
      requirementState,
      mapped: preflight.mapped ?? [],
      unavailable: preflight.unavailable ?? [],
      ...(preflight.adapterIdentity ? { adapterIdentity: preflight.adapterIdentity } : {}),
      blocked: Boolean(diagnostic),
    };
    extensions.push(extensionPlan);
    actions.push({
      kind: "package",
      id: `plugin:${extension.ref}`,
      action: preflight.ok && preflight.action === "reuse" ? "reuse" : "install",
      target: `${extension.source}:${extension.ref}@${extension.version}`,
      ...(preflight.integrity ? { digest: preflight.integrity } : {}),
      details: {
        kind: "plugin",
        source: extension.source,
        ref: extension.ref,
        version: extension.version,
        ...(preflight.integrity ? { integrity: preflight.integrity } : {}),
        ...(preflight.installId ? { installId: preflight.installId } : {}),
        ...(preflight.action ? { ownerAction: preflight.action } : {}),
        requirementState,
        ...(preflight.requirements ? { prerequisites: preflight.requirements } : {}),
        ...(completeProvenance
          ? {
              extension: {
                id: extension.id,
                format: extension.format,
                detectedFormat: preflight.detectedFormat!,
                mapped: preflight.mapped ?? [],
                unavailable: preflight.unavailable ?? [],
                adapterIdentity: preflight.adapterIdentity!,
              },
            }
          : {}),
        expectedState: !preflight.ok
          ? "unresolved"
          : preflight.action === "reuse"
            ? "present-exact"
            : "absent",
        ...(preflight.warning ? { riskWarning: preflight.warning } : {}),
      },
      blocked: extensionPlan.blocked,
      ...(diagnostic ? { reason: diagnostic.message } : {}),
    });
    capabilityChanges.push(extensionCapabilityChange({ extension, preflight }));
  }

  return { extensions, actions, capabilityChanges, requirements, blockers };
}
