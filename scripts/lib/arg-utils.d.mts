type FlagArgs = Record<string, unknown>;
type FlagSpec<T extends FlagArgs> = {
  consume(
    argv: readonly string[],
    index: number,
    args: T,
  ): {
    flag?: string;
    nextIndex: number;
    repeatable?: boolean;
    apply(target?: T): void;
  } | null;
};

export function readFlagValue(args: readonly string[], name: string): string | undefined;
export function stripLeadingPackageManagerSeparator(argv: string[]): string[];
export function stringFlag<T extends FlagArgs>(
  flag: string,
  key: string,
  options?: {
    allowEmpty?: boolean;
    allowInline?: boolean;
    missingValueMessage?: string;
    rejectShortOptions?: boolean;
    repeatable?: boolean;
    transform?: (value: string) => unknown;
  },
): FlagSpec<T>;
export function stringListFlag<T extends FlagArgs>(
  flag: string,
  key: string,
  options?: {
    allowEmpty?: boolean;
    allowInline?: boolean;
    missingValueMessage?: string;
    rejectShortOptions?: boolean;
  },
): FlagSpec<T>;
export function intFlag<T extends FlagArgs>(
  flag: string,
  key: string,
  options?: { min?: number },
): FlagSpec<T>;
export function booleanFlag<T extends FlagArgs>(
  flag: string,
  key: string,
  value?: unknown,
  options?: { repeatable?: boolean },
): FlagSpec<T>;
export function parseFlagArgs<T extends FlagArgs>(
  argv: readonly string[],
  args: T,
  specs: readonly FlagSpec<T>[],
  options?: {
    allowUnknownOptions?: boolean;
    duplicateOptionMessage?: (flag: string) => string;
    ignoreDoubleDash?: boolean;
    onUnhandledArg?: (arg: string, args: T) => "handled" | void;
  },
): T;
