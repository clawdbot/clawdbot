export function writeFailedTrailer(
  tool: string,
  exitCode: number | string | null | undefined,
  log?: (value: unknown) => void,
): void;
export function runWithFailedTrailer(
  tool: string,
  run: () => void | Promise<void>,
  log?: (value: unknown) => void,
): Promise<void>;
