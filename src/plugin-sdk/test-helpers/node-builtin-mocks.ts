type MockFactory<TModule extends object> =
  | Partial<TModule>
  | ((actual: TModule) => Partial<TModule>);

function resolveMockOverrides<TModule extends object>(
  actual: TModule,
  factory: MockFactory<TModule>,
): Partial<TModule> {
  return typeof factory === "function" ? factory(actual) : factory;
}

function resolveDefaultBase(actual: object): Record<string, unknown> {
  const defaultExport = (actual as { default?: unknown }).default;
  if (defaultExport && typeof defaultExport === "object") {
    return defaultExport as Record<string, unknown>;
  }
  return actual as Record<string, unknown>;
}

export async function mockNodeBuiltinModule<TModule extends object>(
  loadActual: () => Promise<TModule>,
  factory: MockFactory<TModule>,
  options?: { mirrorToDefault?: boolean },
): Promise<TModule> {
  const actual = await loadActual();
  const overrides = resolveMockOverrides(actual, factory);
  const mocked = {
    ...actual,
    ...overrides,
  } as TModule & { default?: Record<string, unknown> };

  if (!options?.mirrorToDefault) {
    return mocked;
  }

  return {
    ...mocked,
    default: {
      ...resolveDefaultBase(actual),
      ...overrides,
    },
  } as TModule;
}

export async function mockNodeChildProcessSpawnSync(
  spawnSync: (...args: unknown[]) => unknown,
): Promise<typeof import("node:child_process")> {
  return mockNodeBuiltinModule(() => import("node:child_process"), {
    spawnSync: (...args: unknown[]) => spawnSync(...args),
  } as Partial<typeof import("node:child_process")>);
}

export async function mockNodeChildProcessExecFile(
  execFile: typeof import("node:child_process").execFile,
): Promise<typeof import("node:child_process")> {
  return mockNodeBuiltinModule(() => import("node:child_process"), {
    execFile,
  } as Partial<typeof import("node:child_process")>);
}
