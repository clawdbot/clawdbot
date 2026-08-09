import type { OpenClawPluginNodeHostCommandAvailabilityContext } from "openclaw/plugin-sdk/plugin-entry";
import { buildPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "zod";

const CapabilityConfigSchema = z.strictObject({
  enabled: z.boolean().optional(),
});

const LinuxNodePluginConfigSchema = z.strictObject({
  notify: CapabilityConfigSchema.optional(),
  camera: CapabilityConfigSchema.optional(),
  location: CapabilityConfigSchema.optional(),
});

export type ResolvedLinuxNodePluginConfig = {
  notify: { enabled: boolean };
  camera: { enabled: boolean };
  location: { enabled: boolean };
};

export function createLinuxNodePluginConfigSchema() {
  return buildPluginConfigSchema(LinuxNodePluginConfigSchema, {
    uiHints: {
      "notify.enabled": {
        label: "Desktop Notifications",
        help: "Expose system.notify when notify-send is installed. Enabled by default.",
      },
      "camera.enabled": {
        label: "Camera",
        help: "Expose camera commands when FFmpeg is installed. Requires a node service restart.",
      },
      "location.enabled": {
        label: "Location",
        help: "Expose location.get when the GeoClue where-am-i demo is installed. Requires a node service restart.",
      },
    },
  });
}

export function resolveLinuxNodePluginConfig(value: unknown): ResolvedLinuxNodePluginConfig {
  const parsed = LinuxNodePluginConfigSchema.safeParse(value ?? {});
  if (!parsed.success) {
    throw new Error(
      `Invalid linux-node plugin config: ${parsed.error.issues[0]?.message ?? "invalid config"}`,
    );
  }
  return {
    notify: { enabled: parsed.data.notify?.enabled ?? true },
    camera: { enabled: parsed.data.camera?.enabled ?? false },
    location: { enabled: parsed.data.location?.enabled ?? false },
  };
}

export function resolveLinuxNodePluginConfigFromHost(
  config: OpenClawPluginNodeHostCommandAvailabilityContext["config"],
): ResolvedLinuxNodePluginConfig | null {
  try {
    return resolveLinuxNodePluginConfig(config.plugins?.entries?.["linux-node"]?.config);
  } catch {
    return null;
  }
}
