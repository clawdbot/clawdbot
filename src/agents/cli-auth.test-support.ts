import "./cli-credentials.js";

type CliAuthOptions = {
  codexHome?: string;
  allowKeychainPrompt?: boolean;
  platform?: NodeJS.Platform;
  execSync?: (...args: never[]) => unknown;
};

type CliAuthTestApi = {
  readCodexAuth(options?: CliAuthOptions): unknown;
  resetCaches(): void;
};

function getTestApi(): CliAuthTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.cliCredentialsTestApi")
  ] as CliAuthTestApi;
}

export function readCodexAuth(options?: CliAuthOptions): unknown {
  return getTestApi().readCodexAuth(options);
}

export function resetCliAuthCaches(): void {
  getTestApi().resetCaches();
}
