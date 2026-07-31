export function resolvePathEnvKey(env: NodeJS.ProcessEnv): string;
export function resolveWindowsSystem32Path(executableName: string, env?: NodeJS.ProcessEnv): string;
export function resolveWindowsCmdExePath(env?: NodeJS.ProcessEnv): string;
export function resolveWindowsPowerShellPath(env?: NodeJS.ProcessEnv): string;
export function buildCmdExeCommandLine(command: string, args: string[]): string;
