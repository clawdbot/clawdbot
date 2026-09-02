import path from "node:path";
import { booleanFlag, parseFlagArgs, stringFlag, type FlagSpec } from "./arg-utils.mts";

type VersionScriptFormat = "json" | "shell";
type CommonVersionCliOptions = {
  appStoreRevision: string | null;
  help: boolean;
  releaseVersion: string | null;
  rootDir: string;
};
type VersionQueryCliOptions = CommonVersionCliOptions & {
  field: string | null;
  format: VersionScriptFormat;
};
type VersionSyncMode = "check" | "write";
type VersionSyncCliOptions = CommonVersionCliOptions & {
  mode: VersionSyncMode;
};

function versionValueFlag<T extends Record<string, unknown>>(
  flag: string,
  key: string,
  transform?: (value: string) => unknown,
): FlagSpec<T> {
  return stringFlag<T>(flag, key, {
    allowInline: false,
    missingValueMessage: `Missing value for ${flag}.`,
    rejectShortOptions: true,
    repeatable: true,
    transform,
  });
}

function parseVersionArgs<T extends CommonVersionCliOptions & Record<string, unknown>>(
  argv: string[],
  args: T,
  specs: FlagSpec<T>[],
  allowAppStoreRevision: boolean,
): T {
  const commonSpecs = [
    versionValueFlag<T>("--root", "rootDir", path.resolve),
    ...(allowAppStoreRevision ? [versionValueFlag<T>("--revision", "appStoreRevision")] : []),
    versionValueFlag<T>("--version", "releaseVersion"),
    booleanFlag<T>("-h", "help", true, { repeatable: true }),
    booleanFlag<T>("--help", "help", true, { repeatable: true }),
  ];
  return parseFlagArgs(argv, args, [...specs, ...commonSpecs], {
    onUnhandledArg(arg) {
      throw new Error(`Unknown argument: ${arg}`);
    },
  });
}

export function parseVersionQueryArgs(
  argv: string[],
  options?: { allowAppStoreRevision?: boolean },
): VersionQueryCliOptions {
  return parseVersionArgs<VersionQueryCliOptions & Record<string, unknown>>(
    argv,
    {
      appStoreRevision: null,
      field: null,
      format: "json",
      help: false,
      releaseVersion: null,
      rootDir: path.resolve("."),
    },
    [
      versionValueFlag("--field", "field"),
      booleanFlag("--json", "format", "json", { repeatable: true }),
      booleanFlag("--shell", "format", "shell", { repeatable: true }),
    ],
    options?.allowAppStoreRevision === true,
  );
}

export function parseVersionSyncArgs(
  argv: string[],
  options?: { allowAppStoreRevision?: boolean },
): VersionSyncCliOptions {
  return parseVersionArgs<VersionSyncCliOptions & Record<string, unknown>>(
    argv,
    {
      appStoreRevision: null,
      help: false,
      mode: "write",
      releaseVersion: null,
      rootDir: path.resolve("."),
    },
    [
      booleanFlag("--check", "mode", "check", { repeatable: true }),
      booleanFlag("--write", "mode", "write", { repeatable: true }),
    ],
    options?.allowAppStoreRevision === true,
  );
}
