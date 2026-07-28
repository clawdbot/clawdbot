export type FixtureJson = Record<string, unknown> & {
  bin?: string | { codex?: string };
  name?: string;
};

export function json(value: unknown): string;
export function readJson(file: string): FixtureJson;
export function write(file: string, contents: string | NodeJS.ArrayBufferView): void;
export function writeJson(file: string, value: unknown): void;
export function requireArg(value: string | undefined, name: string): string;
export function assert(condition: unknown, message: string): asserts condition;
