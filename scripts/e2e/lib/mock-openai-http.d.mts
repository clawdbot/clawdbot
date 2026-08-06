export function readMockOpenAiHttpLimits(env?: NodeJS.ProcessEnv): {
  requestMaxBytes?: number;
  requestLogBodyMaxBytes?: number;
};
export function isRequestBodyTooLargeError(error: unknown): error is Error;
export function readBody(
  req: unknown,
  limits?: {
    requestMaxBytes?: number;
    requestLogBodyMaxBytes?: number;
  },
): Promise<string>;
export function boundedRequestLogBody(
  value: unknown,
  bodyText: unknown,
  limits?: {
    requestMaxBytes?: number;
    requestLogBodyMaxBytes: number;
  },
): unknown;
export function writeRequestLogEntryOrFail(
  res: unknown,
  {
    requestLog,
    entry,
    label,
    required,
  }: {
    requestLog: unknown;
    entry: unknown;
    label?: string | undefined;
    required?: boolean | undefined;
  },
): boolean;
export function writeJson(res: unknown, status: unknown, body: unknown): void;
export function writeSse(res: unknown, events: unknown): void;
