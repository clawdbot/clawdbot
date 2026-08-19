// Typed bridge to the plain-Node Windows command helpers.
const runtimeSpecifier = "../windows-cmd-helpers.mjs";
const runtime: unknown = await import(runtimeSpecifier);

function isRuntimeRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function runtimeFunction(name: string): (...args: unknown[]) => unknown {
  if (!isRuntimeRecord(runtime) || !(name in runtime)) {
    throw new Error(`windows command helper is missing ${name}`);
  }
  const value = runtime[name];
  if (typeof value !== "function") {
    throw new Error(`windows command helper ${name} is not callable`);
  }
  return (...args) => value(...args);
}

const buildCmdExeCommandLineImpl = runtimeFunction("buildCmdExeCommandLine");
const resolvePathEnvKeyImpl = runtimeFunction("resolvePathEnvKey");
const resolveWindowsCmdExePathImpl = runtimeFunction("resolveWindowsCmdExePath");

export function buildCmdExeCommandLine(command: string, args: string[]): string {
  const result = buildCmdExeCommandLineImpl(command, args);
  if (typeof result !== "string") {
    throw new Error("buildCmdExeCommandLine returned a non-string result");
  }
  return result;
}

export function resolvePathEnvKey(env: NodeJS.ProcessEnv): string {
  const result = resolvePathEnvKeyImpl(env);
  if (typeof result !== "string") {
    throw new Error("resolvePathEnvKey returned a non-string result");
  }
  return result;
}

export function resolveWindowsCmdExePath(env: NodeJS.ProcessEnv = process.env): string {
  const result = resolveWindowsCmdExePathImpl(env);
  if (typeof result !== "string") {
    throw new Error("resolveWindowsCmdExePath returned a non-string result");
  }
  return result;
}
