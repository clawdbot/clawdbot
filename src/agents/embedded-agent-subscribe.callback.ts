import { isPromiseLike } from "./embedded-agent-subscribe.promise.js";

type CallbackLogger = {
  warn(message: string): void;
};

/** Contains failures from untracked subscriber presentation and telemetry callbacks. */
export function runBestEffortCallback(params: {
  callback: () => void | Promise<void>;
  label: string;
  log: CallbackLogger;
}): void {
  try {
    const result = params.callback();
    if (isPromiseLike<void>(result)) {
      void Promise.resolve(result).catch((error: unknown) => {
        params.log.warn(`${params.label} callback failed: ${String(error)}`);
      });
    }
  } catch (error) {
    params.log.warn(`${params.label} callback failed: ${String(error)}`);
  }
}
