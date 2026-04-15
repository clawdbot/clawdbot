import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { isRecord } from "./src/record-shared.js";

function listContainsBrowser(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((entry) => normalizeOptionalLowercaseString(entry) === "browser")
  );
}

function toolPolicyReferencesBrowser(value: unknown): boolean {
  return (
    isRecord(value) && (listContainsBrowser(value.allow) || listContainsBrowser(value.alsoAllow))
  );
}

function hasBrowserToolReference(config: OpenClawConfig): boolean {
  if (toolPolicyReferencesBrowser(config.tools)) {
    return true;
  }
  const agentList = config.agents?.list;
  return Array.isArray(agentList)
    ? agentList.some((entry) => isRecord(entry) && toolPolicyReferencesBrowser(entry.tools))
    : false;
}

export default definePluginEntry({
  id: "browser",
  name: "Browser Setup",
  description: "Lightweight Browser setup hooks",
  register(api) {
    api.registerAutoEnableProbe(({ config }) => {
      if (
        config.browser?.enabled === false ||
        config.plugins?.entries?.browser?.enabled === false
      ) {
        return null;
      }
      if (Object.prototype.hasOwnProperty.call(config, "browser")) {
        return "browser configured";
      }
      if (
        config.plugins?.entries &&
        Object.prototype.hasOwnProperty.call(config.plugins.entries, "browser")
      ) {
        return "browser plugin configured";
      }
      if (hasBrowserToolReference(config)) {
        return "browser tool referenced";
      }
      return null;
    });
  },
});
