const warningFilterKey = Symbol.for("openclaw.warning-filter");

export function installProcessWarningFilter() {
  if (globalThis[warningFilterKey]?.installed) {
    return;
  }

  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = (...args) => {
    const [warningArg, secondArg, thirdArg] = args;
    const warning =
      warningArg instanceof Error
        ? {
            name: warningArg.name,
            message: warningArg.message,
            code: warningArg.code,
          }
        : {
            name: typeof secondArg === "string" ? secondArg : secondArg?.type,
            message: typeof warningArg === "string" ? warningArg : undefined,
            code: typeof thirdArg === "string" ? thirdArg : secondArg?.code,
          };

    if (warning.code === "DEP0040" && warning.message?.includes("punycode")) {
      return;
    }

    Reflect.apply(originalEmitWarning, process, args);
  };

  globalThis[warningFilterKey] = { installed: true };
}
