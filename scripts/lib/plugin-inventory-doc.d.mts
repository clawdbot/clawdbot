export type PluginSurfaceManifest = {
  channels?: string[];
  providers?: string[];
  contracts?: Record<string, unknown>;
  skills?: unknown[];
};

/** Render translatable surface labels with exact manifest identifiers as inline code. */
export function resolvePluginSurface(manifest: PluginSurfaceManifest): string;
