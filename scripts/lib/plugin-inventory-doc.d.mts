export type PluginSurfaceManifest = {
  id?: string;
  channels?: string[];
  providers?: string[];
  contracts?: Record<string, unknown>;
  dashboard?: {
    dataBindings?: Array<{ id?: string }>;
    actionVerbs?: Array<{ id?: string }>;
  };
  skills?: unknown[];
};

/** Render translatable surface labels with exact manifest identifiers as inline code. */
export function resolvePluginSurface(manifest: PluginSurfaceManifest): string;
