import {
  createRuntimeProviderAuthLookup,
  type RuntimeProviderAuthLookup,
} from "../../model-auth.js";
import type { RunEmbeddedAgentParams } from "./params.js";

export function createIsolatedPluginAuthResolver(params: {
  cfg: RunEmbeddedAgentParams["config"];
  workspaceDir: string;
}) {
  let runtimeAuthLookup: RuntimeProviderAuthLookup | undefined;
  return (allowAuthProfileFallback?: boolean) => {
    if (allowAuthProfileFallback !== false) {
      return {};
    }
    runtimeAuthLookup ??= createRuntimeProviderAuthLookup({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
    });
    return {
      allowPluginSyntheticAuth: true as const,
      runtimeLookup: runtimeAuthLookup,
    };
  };
}
