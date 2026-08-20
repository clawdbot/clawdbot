// Installs a process-wide warning filter for dependency warnings that are known
// noise in current toolchains.
const warningFilterKey = Symbol.for("openclaw.warning-filter");
type EmitWarningArgs =
  | [warning: string | Error, ctor?: Function]
  | [warning: string | Error, type?: string, ctor?: Function]
  | [warning: string | Error, options?: NodeJS.EmitWarningOptions]
  | [warning: string | Error, type?: string, code?: string, ctor?: Function];

/**
 * Suppresses punycode deprecation warnings while preserving all other warnings.
 */
export function installProcessWarningFilter(): void {
  const state: unknown = Reflect.get(globalThis, warningFilterKey);
  if (state && typeof state === "object" && "installed" in state && state.installed === true) {
    return;
  }

  const originalEmitWarning = process.emitWarning.bind(process);
  const filteredEmitWarning = ((...args: EmitWarningArgs): void => {
    const [warningArg, secondArg, thirdArg] = args;
    const options = typeof secondArg === "object" ? secondArg : undefined;
    const warning =
      warningArg instanceof Error
        ? {
            name: warningArg.name,
            message: warningArg.message,
            code: "code" in warningArg ? warningArg.code : undefined,
          }
        : {
            name: typeof secondArg === "string" ? secondArg : options?.type,
            message: typeof warningArg === "string" ? warningArg : undefined,
            code: typeof thirdArg === "string" ? thirdArg : options?.code,
          };

    if (warning.code === "DEP0040" && warning.message?.includes("punycode")) {
      return;
    }

    Reflect.apply(originalEmitWarning, process, args);
  }) satisfies typeof process.emitWarning;
  process.emitWarning = filteredEmitWarning;

  Reflect.set(globalThis, warningFilterKey, { installed: true });
}
