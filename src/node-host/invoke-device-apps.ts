import { z } from "zod";
import { scanInstalledApps, type InstalledApp } from "../infra/installed-apps.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

const DeviceAppsParamsSchema = z
  .object({
    query: z.string().trim().min(1).optional(),
    limit: z
      .number()
      .int()
      .transform((value) => Math.min(MAX_LIMIT, Math.max(1, value)))
      .optional(),
    includeSystem: z.boolean().optional(),
  })
  .strict();

type DeviceAppsPayload = {
  count: number;
  totalMatched: number;
  truncated: boolean;
  apps: InstalledApp[];
};

type DeviceAppsInvokeResult =
  | { ok: true; payload: DeviceAppsPayload }
  | { ok: false; code: string; message: string };

export async function invokeDeviceApps(params: {
  paramsJSON?: string | null;
  sharingEnabled: boolean;
  platform?: NodeJS.Platform;
  scan?: typeof scanInstalledApps;
}): Promise<DeviceAppsInvokeResult> {
  if (!params.sharingEnabled) {
    return {
      ok: false,
      code: "INSTALLED_APPS_SHARING_DISABLED",
      message: "INSTALLED_APPS_SHARING_DISABLED: enable Installed Apps in node-host settings",
    };
  }
  let request: z.infer<typeof DeviceAppsParamsSchema>;
  try {
    request = DeviceAppsParamsSchema.parse(JSON.parse(params.paramsJSON || "{}"));
  } catch (error) {
    return { ok: false, code: "INVALID_REQUEST", message: String(error) };
  }
  const scan = params.scan ?? scanInstalledApps;
  const inventory = await scan({ platform: params.platform ?? process.platform });
  if (inventory.status === "unsupported") {
    return {
      ok: false,
      code: "UNAVAILABLE",
      message: "UNAVAILABLE: installed application inventory is only available on macOS",
    };
  }
  const query = request.query?.toLocaleLowerCase("en-US");
  const matching = inventory.apps.filter(
    (app) =>
      (request.includeSystem === true || !app.system) &&
      (!query ||
        app.label.toLocaleLowerCase("en-US").includes(query) ||
        app.bundleId?.toLocaleLowerCase("en-US").includes(query)),
  );
  const apps = matching.slice(0, request.limit ?? DEFAULT_LIMIT);
  return {
    ok: true,
    payload: {
      count: apps.length,
      totalMatched: matching.length,
      truncated: matching.length > apps.length,
      apps,
    },
  };
}
