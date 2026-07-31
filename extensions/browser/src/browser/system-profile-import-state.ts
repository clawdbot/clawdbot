import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

const IMPORT_STATE_KEY = "onboarding";
const IMPORT_PROFILE_BASENAME = "imported";

export type SystemProfileImportState =
  | {
      version: 1;
      status: "dismissed";
      updatedAt: number;
    }
  | {
      version: 1;
      status: "imported";
      browser: string;
      systemProfile: string;
      targetProfile: string;
      updatedAt: number;
    };

let importStateStore: PluginStateKeyedStore<SystemProfileImportState> | undefined;

export function configureSystemProfileImportStateStore(
  store: PluginStateKeyedStore<SystemProfileImportState>,
): void {
  importStateStore = store;
}

export async function readSystemProfileImportState(): Promise<
  SystemProfileImportState | undefined
> {
  return await importStateStore?.lookup(IMPORT_STATE_KEY);
}

export async function dismissSystemProfileImportPrompt(now = Date.now()): Promise<void> {
  await importStateStore?.register(IMPORT_STATE_KEY, {
    version: 1,
    status: "dismissed",
    updatedAt: now,
  });
}

export async function recordSystemProfileImport(
  params: { browser: string; systemProfile: string; targetProfile: string },
  now = Date.now(),
): Promise<void> {
  await importStateStore?.register(IMPORT_STATE_KEY, {
    version: 1,
    status: "imported",
    browser: params.browser,
    systemProfile: params.systemProfile,
    targetProfile: params.targetProfile,
    updatedAt: now,
  });
}

export function resolveSuggestedImportTarget(params: {
  profileNames: Iterable<string>;
  state?: SystemProfileImportState;
}): string {
  const names = new Set(params.profileNames);
  if (params.state?.status === "imported" && names.has(params.state.targetProfile)) {
    return params.state.targetProfile;
  }
  if (!names.has(IMPORT_PROFILE_BASENAME)) {
    return IMPORT_PROFILE_BASENAME;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${IMPORT_PROFILE_BASENAME}-${suffix}`;
    if (!names.has(candidate)) {
      return candidate;
    }
  }
}
