import { clearActiveProgressLine } from "./terminal/progress-line.js";

export type RuntimeEnv = {
  log: typeof console.log;
  error: typeof console.error;
  exit: (code: number) => never;
};

export const defaultRuntime: RuntimeEnv = {
  log: (...args: Parameters<typeof console.log>) => {
    clearActiveProgressLine();
    console.log(...args);
  },
  error: (...args: Parameters<typeof console.error>) => {
    clearActiveProgressLine();
    console.error(...args);
  },
  exit: (code) => {
    process.exit(code);
    throw new Error("unreachable"); // satisfies tests when mocked
  },
};
