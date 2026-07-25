export function readPositiveIntEnv(
  name: unknown,
  fallback: unknown,
  env?: NodeJS.ProcessEnv,
): number;
export function readTcpPortEnv(name: unknown, fallback: unknown, env?: NodeJS.ProcessEnv): number;
