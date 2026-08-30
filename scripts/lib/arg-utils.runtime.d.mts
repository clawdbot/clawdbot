type StringOptions = {
  allowEmpty?: boolean;
  allowInline?: boolean;
  missingValueMessage?: string;
  rejectShortOptions?: boolean;
  repeatable?: boolean;
  transform?: (value: string) => unknown;
};

type ConsumedFlag<T extends Record<string, unknown>> = {
  flag: string;
  nextIndex: number;
  repeatable?: boolean;
  apply(target: T): void;
};

export type FlagSpec<T extends Record<string, unknown>> = {
  consume(argv: readonly string[], index: number, args: T): ConsumedFlag<T> | null;
};

type ParseOptions<T extends Record<string, unknown>> = {
  allowUnknownOptions?: boolean;
  duplicateOptionMessage?: (flag: string) => string;
  ignoreDoubleDash?: boolean;
  onUnhandledArg?: (arg: string, args: T) => "handled" | void;
};

export type BoundedUnsignedDecimalResult =
  | { kind: "syntax" }
  | { kind: "below" }
  | { kind: "above" }
  | { kind: "value"; value: number };

export function readFlagValue(args: readonly string[], name: string): string | undefined;
export function stripLeadingPackageManagerSeparator(argv: string[]): string[];
export function parseStrictBooleanArg(value: unknown, label: string): boolean;
export function classifyBoundedUnsignedDecimal(
  value: unknown,
  min: number,
  max: number,
): BoundedUnsignedDecimalResult;
export function parsePermissiveBooleanToken(value: unknown): boolean | undefined;
export function isOpenEndedTruthyValue(value: string | undefined): boolean;
export function isStrictAffirmativeValue(value: string | undefined): boolean;
export function stringFlag<T extends Record<string, unknown>>(
  flag: string,
  key: string,
  options?: StringOptions,
): FlagSpec<T>;
export function stringListFlag<T extends Record<string, unknown>>(
  flag: string,
  key: string,
  options?: Omit<StringOptions, "repeatable" | "transform">,
): FlagSpec<T>;
export function intFlag<T extends Record<string, unknown>>(
  flag: string,
  key: string,
  options?: { min?: number },
): FlagSpec<T>;
export function booleanFlag<T extends Record<string, unknown>>(
  flag: string,
  key: string,
  value?: unknown,
  options?: { repeatable?: boolean },
): FlagSpec<T>;
export function parseFlagArgs<T extends Record<string, unknown>>(
  argv: readonly string[],
  args: T,
  specs: readonly FlagSpec<T>[],
  options?: ParseOptions<T>,
): T;
