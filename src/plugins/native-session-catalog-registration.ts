import fs from "node:fs";
import { resolveConfigPath } from "../config/paths.js";
import {
  hasLegacyNativeSessionCatalogDefault,
  readNativeSessionCatalogPreference,
} from "./native-session-catalog-config.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { SessionCatalogProvider } from "./session-catalog.js";
import type { OpenClawPluginNodeHostCommand } from "./types.node-host.js";

function hasReadableNativeCatalogConfig(): boolean {
  try {
    const configPath = resolveConfigPath();
    const link = fs.lstatSync(configPath);
    const file = link.isSymbolicLink() ? fs.statSync(configPath) : link;
    if (!file.isFile()) {
      return false;
    }
    fs.accessSync(configPath, fs.constants.R_OK);
    return true;
  } catch {
    // Missing, unreadable, and dangling paths cannot establish the legacy default.
    return false;
  }
}

export function createNativeSessionCatalogGate(params: {
  pluginId: string;
  getConfig: PluginRuntime["config"]["current"];
}) {
  const legacyDefaultAllowed =
    hasLegacyNativeSessionCatalogDefault(params.pluginId) && hasReadableNativeCatalogConfig();
  const enabled = () =>
    readNativeSessionCatalogPreference(params.getConfig(), params.pluginId) ?? legacyDefaultAllowed;
  const assertEnabled = () => {
    if (!enabled()) {
      throw new Error(
        `Native conversation discovery is disabled for ${params.pluginId}. Enable it in that plugin's settings.`,
      );
    }
  };
  return {
    catalog(provider: SessionCatalogProvider): SessionCatalogProvider {
      const {
        continueSession,
        copyToGatewaySession,
        archive,
        openTerminal,
        checkUpstreamActivity,
      } = provider;
      return {
        ...provider,
        list: async (query) => (enabled() ? provider.list(query) : []),
        read: async (request) => {
          assertEnabled();
          return provider.read(request);
        },
        ...(continueSession
          ? {
              continueSession: async (request) => {
                assertEnabled();
                return continueSession.call(provider, request);
              },
            }
          : {}),
        ...(copyToGatewaySession
          ? {
              copyToGatewaySession: async (request) => {
                assertEnabled();
                return copyToGatewaySession.call(provider, request);
              },
            }
          : {}),
        ...(archive
          ? {
              archive: async (request) => {
                assertEnabled();
                return archive.call(provider, request);
              },
            }
          : {}),
        ...(openTerminal
          ? {
              openTerminal: async (request) => {
                assertEnabled();
                return openTerminal.call(provider, request);
              },
            }
          : {}),
        ...(checkUpstreamActivity
          ? {
              checkUpstreamActivity: async (probes, policy) =>
                enabled() ? checkUpstreamActivity.call(provider, probes, policy) : [],
            }
          : {}),
      };
    },
    node(command: OpenClawPluginNodeHostCommand): OpenClawPluginNodeHostCommand {
      const { prepare, watchAvailability } = command;
      return {
        ...command,
        isAvailable: (context) => enabled() && (command.isAvailable?.(context) ?? true),
        ...(prepare
          ? {
              prepare: (context) => {
                if (enabled()) {
                  return prepare.call(command, context);
                }
              },
            }
          : {}),
        ...(watchAvailability
          ? {
              watchAvailability: (context, onChange) => {
                if (enabled()) {
                  return watchAvailability.call(command, context, onChange);
                }
              },
            }
          : {}),
        handle: async (...args) => {
          assertEnabled();
          return command.handle(...args);
        },
      };
    },
  };
}
