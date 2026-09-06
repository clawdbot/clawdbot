import { withEnvAsync } from "../test-utils/env.js";
import { mergeProcessEnv, resolveEnvironmentValue } from "./process-env.js";

// Capture before platform mocks or env replacement: clearing a Windows fork's native
// parent removes libuv's bootstrap fallback. Uppercase roots also survive logical POSIX probes.
const nativePlatform = process.platform;
const nativeBootstrapEnv: NodeJS.ProcessEnv =
  nativePlatform === "win32"
    ? {
        SYSTEMROOT: resolveEnvironmentValue(process.env, "SYSTEMROOT", nativePlatform),
        WINDIR: resolveEnvironmentValue(process.env, "WINDIR", nativePlatform),
      }
    : {};

export function createDiagnosticFixtureRouting(routing: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return mergeProcessEnv([routing, nativeBootstrapEnv], nativePlatform);
}

export const diagnosticCanaries = {
  DIAGNOSTIC_NEUTRAL_CANARY: "synthetic-neutral",
  OPENAI_API_KEY: "synthetic-provider",
  OPENCLAW_GATEWAY_TOKEN: "synthetic-token",
  NODE_OPTIONS: "--no-warnings",
  LC_DIAGNOSTIC_CANARY: "synthetic-locale",
  HTTPS_PROXY: "http://proxy.invalid",
};

export function diagnosticEnvReportScript(routing: NodeJS.ProcessEnv): string {
  return `JSON.stringify({
    present: Object.fromEntries(${JSON.stringify(Object.keys(diagnosticCanaries))}.map(key => [key, Object.hasOwn(process.env, key)])),
    routingPreserved: Object.entries(${JSON.stringify(routing)}).every(([key, value]) => process.env[key] === value)
  })`;
}

// Clear ambient values before launching fixtures: even the pre-fix child sees only fixture inputs.
export async function withSyntheticDiagnosticEnv(
  routing: NodeJS.ProcessEnv,
  run: () => Promise<void>,
): Promise<void> {
  await withEnvAsync(
    {
      ...Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined])),
      ...diagnosticCanaries,
      ...routing,
    },
    run,
  );
}
