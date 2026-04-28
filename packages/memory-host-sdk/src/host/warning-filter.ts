const warningFilterKey = Symbol.for("openclaw.warning-filter");

export type ProcessWarning = {
  code?: string;
  name?: string;
  message?: string;
};

type ProcessWarningInstallState = {
  installed: boolean;
};

function resolveWarningFilterState(): ProcessWarningInstallState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  if (Object.prototype.hasOwnProperty.call(globalStore, warningFilterKey)) {
    return globalStore[warningFilterKey] as ProcessWarningInstallState;
  }
  const state = { installed: false };
  globalStore[warningFilterKey] = state;
  return state;
}

export function shouldIgnoreWarning(warning: ProcessWarning): boolean {
  if (warning.code === "DEP0040" && warning.message?.includes("punycode")) {
    return true;
  }
  if (warning.code === "DEP0060" && warning.message?.includes("util._extend")) {
    return true;
  }
  if (
    warning.name === "ExperimentalWarning" &&
    warning.message?.includes("SQLite is an experimental feature")
  ) {
    return true;
  }
  return false;
}

function normalizeWarningArgs(args: unknown[]): ProcessWarning {
  const warningArg = args[0];
  const secondArg = args[1];
  const thirdArg = args[2];
  let name: string | undefined;
  let code: string | undefined;
  let message: string | undefined;

  if (warningArg instanceof Error) {
    name = warningArg.name;
    message = warningArg.message;
    code = (warningArg as Error & { code?: string }).code;
  } else if (typeof warningArg === "string") {
    message = warningArg;
  }

  if (secondArg && typeof secondArg === "object" && !Array.isArray(secondArg)) {
    const options = secondArg as { type?: unknown; code?: unknown };
    if (typeof options.type === "string") {
      name = options.type;
    }
    if (typeof options.code === "string") {
      code = options.code;
    }
  } else {
    if (typeof secondArg === "string") {
      name = secondArg;
    }
    if (typeof thirdArg === "string") {
      code = thirdArg;
    }
  }

  return { name, code, message };
}

export function installProcessWarningFilter(): void {
  const state = resolveWarningFilterState();
  if (state.installed) {
    return;
  }

  const originalEmitWarning = process.emitWarning.bind(process);
  const wrappedEmitWarning: typeof process.emitWarning = ((...args: unknown[]) => {
    if (shouldIgnoreWarning(normalizeWarningArgs(args))) {
      return;
    }
    if (
      args[0] instanceof Error &&
      args[1] &&
      typeof args[1] === "object" &&
      !Array.isArray(args[1])
    ) {
      const warning = args[0];
      const emitted = Object.assign(new Error(warning.message), {
        name: warning.name,
        code: (warning as Error & { code?: string }).code,
      });
      process.emit("warning", emitted);
      return;
    }
    Reflect.apply(originalEmitWarning, process, args);
  }) as typeof process.emitWarning;

  process.emitWarning = wrappedEmitWarning;
  state.installed = true;
}
