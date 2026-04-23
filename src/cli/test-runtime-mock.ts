import type { vi } from "vitest";

type ViLike = Pick<typeof vi, "fn">;

export function createCliRuntimeMock(
  viInstance: ViLike,
  options: {
    exitPrefix?: string;
  } = {},
) {
  const runtimeLogs: string[] = [];
  const runtimeErrors: string[] = [];
  const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
  const defaultRuntime = {
    log: viInstance.fn((...args: unknown[]) => {
      runtimeLogs.push(stringifyArgs(args));
    }),
    error: viInstance.fn((...args: unknown[]) => {
      runtimeErrors.push(stringifyArgs(args));
    }),
    writeStdout: viInstance.fn((value: string) => {
      defaultRuntime.log(value.endsWith("\n") ? value.slice(0, -1) : value);
    }),
    writeJson: viInstance.fn((value: unknown, space = 2) => {
      defaultRuntime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    exit: viInstance.fn((code: number) => {
      throw new Error(`${options.exitPrefix ?? "__exit__"}:${code}`);
    }),
  };
  return {
    defaultRuntime,
    runtimeLogs,
    runtimeErrors,
  };
}
