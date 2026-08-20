// Packed Plugin Sdk Type Smoke script supports OpenClaw repository automation.
import type {
  MemoryReadResult,
  MemorySearchManager,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

type PublicPluginSdkModules = [
  typeof import("openclaw/plugin-sdk/core"),
  typeof import("openclaw/plugin-sdk/channel-entry-contract"),
  typeof import("openclaw/plugin-sdk/config-contracts"),
  typeof import("openclaw/plugin-sdk/plugin-entry"),
  typeof import("openclaw/plugin-sdk/runtime-env"),
];

const resolvedModules = null as unknown as PublicPluginSdkModules;
declare const canonicalManagerRest: Omit<MemorySearchManager, "readFile">;
declare const canonicalReadResult: MemoryReadResult;

const legacyManager = {
  ...canonicalManagerRest,
  async readFile({ relPath }: { relPath: string }) {
    return { text: "", path: relPath };
  },
};
const legacyRuntime = {
  async getMemorySearchManager() {
    return { manager: legacyManager };
  },
  resolveMemoryBackendConfig() {
    return { backend: "builtin" as const };
  },
} satisfies MemoryPluginRuntime;
type BareLegacyReadResult = { text: ""; path: string };
const canonicalRejectsBareLegacy: BareLegacyReadResult extends MemoryReadResult ? false : true =
  true;

void resolvedModules;
void legacyRuntime;
void canonicalReadResult.from;
void canonicalReadResult.lines;
void canonicalReadResult.truncated;
void canonicalReadResult.nextFrom;
void canonicalRejectsBareLegacy;
