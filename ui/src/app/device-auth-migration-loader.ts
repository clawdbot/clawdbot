import type { GatewayBrowserClient } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";
import type {
  DeviceAuthMigrationController,
  DeviceAuthMigrationSnapshot,
} from "./device-auth-migration.ts";
import type { ApplicationGateway } from "./gateway.ts";

export const EMPTY_DEVICE_AUTH_MIGRATION: DeviceAuthMigrationSnapshot = {
  requestId: null,
  busy: false,
  error: null,
};

export function createDeviceAuthMigrationLoader(params: {
  gateway: ApplicationGateway;
  isCurrent: (client: GatewayBrowserClient, epoch: number) => boolean;
  onChange: (snapshot: DeviceAuthMigrationSnapshot) => void;
}) {
  let controllerPromise: Promise<DeviceAuthMigrationController | null> | null = null;
  let disposed = false;

  const reset = () => {
    void controllerPromise?.then((controller) => controller?.reset());
    params.onChange(EMPTY_DEVICE_AUTH_MIGRATION);
  };
  const load = (client: GatewayBrowserClient, epoch: number) => {
    // This is a rare upgrade-only flow. Load it once when hello reports the
    // pending transition so ordinary Control UI startup does not pay its cost.
    controllerPromise ??= import("./device-auth-migration.ts")
      .then(({ createDeviceAuthMigrationController }) => {
        if (disposed) {
          return null;
        }
        return createDeviceAuthMigrationController(params);
      })
      .catch((error: unknown) => {
        controllerPromise = null;
        if (params.isCurrent(client, epoch)) {
          params.onChange({
            ...EMPTY_DEVICE_AUTH_MIGRATION,
            error: t("login.deviceAuthMigration.loadFailed", {
              error: error instanceof Error ? error.message : String(error),
            }),
          });
        }
        return null;
      });
    return controllerPromise;
  };

  return {
    reset,
    async refresh(client: GatewayBrowserClient, epoch: number) {
      if (params.gateway.snapshot.hello?.deviceAuthMigration?.pending !== true) {
        reset();
        return;
      }
      const controller = await load(client, epoch);
      if (!controller || !params.isCurrent(client, epoch)) {
        controller?.reset();
        return;
      }
      await controller.refresh(client, epoch);
    },
    async secure(client: GatewayBrowserClient | null, epoch: number) {
      await (await controllerPromise)?.secure(client, epoch);
    },
    dispose() {
      disposed = true;
      void controllerPromise?.then((controller) => controller?.dispose());
    },
  };
}
