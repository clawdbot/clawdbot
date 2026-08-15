// Builds payloads for the plugin-runtime before_install lifecycle hook.
import type {
  PluginHookBeforeInstallBuiltinScan,
  PluginHookBeforeInstallContext,
  PluginHookBeforeInstallEvent,
  PluginHookBeforeInstallPlugin,
  PluginHookBeforeInstallRequest,
  PluginHookBeforeInstallSkill,
  PluginInstallSourcePathKind,
  PluginInstallTargetType,
} from "./types.js";

/**
 * Centralized builder for the public before_install hook contract.
 *
 * Keep all payload shaping here so partner feedback lands in one place instead
 * of drifting across individual install codepaths.
 */
type BeforeInstallHookPayloadParams = {
  targetType: PluginInstallTargetType;
  targetName: string;
  origin?: string;
  sourcePath: string;
  sourcePathKind: PluginInstallSourcePathKind;
  request: PluginHookBeforeInstallRequest;
  builtinScan?: PluginHookBeforeInstallBuiltinScan;
  skill?: PluginHookBeforeInstallSkill;
  plugin?: PluginHookBeforeInstallPlugin;
};

function emptyBuiltinScan(): PluginHookBeforeInstallBuiltinScan {
  return {
    status: "ok",
    scannedFiles: 0,
    critical: 0,
    warn: 0,
    info: 0,
    findings: [],
  };
}

export function createBeforeInstallHookPayload(params: BeforeInstallHookPayloadParams): {
  ctx: PluginHookBeforeInstallContext;
  event: PluginHookBeforeInstallEvent;
} {
  const event: PluginHookBeforeInstallEvent = {
    targetType: params.targetType,
    targetName: params.targetName,
    sourcePath: params.sourcePath,
    sourcePathKind: params.sourcePathKind,
    ...(params.origin ? { origin: params.origin } : {}),
    request: params.request,
    builtinScan: params.builtinScan ?? emptyBuiltinScan(),
    ...(params.skill ? { skill: params.skill } : {}),
    ...(params.plugin ? { plugin: params.plugin } : {}),
  };

  const ctx: PluginHookBeforeInstallContext = {
    targetType: params.targetType,
    requestKind: params.request.kind,
    ...(params.origin ? { origin: params.origin } : {}),
  };

  return { event, ctx };
}
