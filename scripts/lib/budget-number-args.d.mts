export function parseBudgetNumber(raw: string | undefined, label: string): number | null;
export function readBudgetEnvNumber(name: string, env?: NodeJS.ProcessEnv): number | null;
export function budgetFloatFlag<Key extends string>(
  flag: string,
  key: Key,
): {
  consume(
    argv: string[],
    index: number,
  ): {
    flag: string;
    nextIndex: number;
    repeatable: false;
    apply(target: Record<Key, number>): void;
  } | null;
};
