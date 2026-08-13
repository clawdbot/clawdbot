// Defines gateway-host desktop config parsing and generated field metadata.
import path from "node:path";
import { z } from "zod";
import type { DesktopConfig } from "./types.desktop.js";
import { configUiMetadata } from "./zod-schema.sensitive.js";

type ConfigSchemaShape<T extends object> = {
  [Key in keyof T]-?: z.ZodType<T[Key]>;
};

type DesktopHostConfig = NonNullable<DesktopConfig["host"]>;

const DesktopHostConfigShape = {
  enabled: z.boolean().register(configUiMetadata, {
    label: "Gateway Host Desktop (Labs)",
    help: "Enables the experimental gateway-host desktop source. Restart the gateway after changing this setting.",
  }),
  managed: z.boolean().optional().register(configUiMetadata, {
    label: "Managed Linux Host Desktop",
    help: "Runs and supervises a loopback-only headless TigerVNC/XFCE desktop on Linux. An explicit port or existing default-port VNC server still takes precedence.",
  }),
  port: z.number().int().min(1).max(65_535).optional().register(configUiMetadata, {
    label: "Gateway Host VNC Port",
    help: "Loopback RFB port of an already-running VNC server on the gateway host (default: 5900).",
  }),
  passwordFile: z
    .string()
    .trim()
    .min(1)
    .refine(path.isAbsolute, "Gateway host VNC passwordFile must be an absolute path")
    .optional()
    .register(configUiMetadata, {
      label: "Gateway Host VNC Password File",
      help: "Absolute path to the VNC password file. Omit on macOS to use account/ARD authentication after that support lands.",
    }),
} satisfies ConfigSchemaShape<DesktopHostConfig>;

const DesktopHostConfigSchema = z
  .object(DesktopHostConfigShape)
  .strict()
  .register(configUiMetadata, {
    label: "Gateway Host Desktop",
    help: "Connects to an existing loopback VNC server or, on Linux, an explicitly enabled managed headless desktop.",
  });

const DesktopConfigShape = {
  host: DesktopHostConfigSchema.optional().register(configUiMetadata, {
    label: "Gateway Host Desktop",
    help: "Experimental gateway-host desktop observation backed by an existing or managed loopback VNC server.",
  }),
} satisfies ConfigSchemaShape<DesktopConfig>;

export const DesktopConfigSchema = z.object(DesktopConfigShape).strict().optional();

const DESKTOP_FIELD_SCHEMAS = {
  "desktop.host": DesktopConfigShape.host,
  "desktop.host.enabled": DesktopHostConfigShape.enabled,
  "desktop.host.managed": DesktopHostConfigShape.managed,
  "desktop.host.port": DesktopHostConfigShape.port,
  "desktop.host.passwordFile": DesktopHostConfigShape.passwordFile,
};

function projectDesktopFieldMetadata(field: "label" | "help"): Record<string, string> {
  return Object.fromEntries(
    Object.entries(DESKTOP_FIELD_SCHEMAS).flatMap(([fieldPath, schema]) => {
      const value = configUiMetadata.get(schema)?.[field];
      return typeof value === "string" ? [[fieldPath, value]] : [];
    }),
  );
}

export const DESKTOP_FIELD_LABELS = projectDesktopFieldMetadata("label");
export const DESKTOP_FIELD_HELP = projectDesktopFieldMetadata("help");
