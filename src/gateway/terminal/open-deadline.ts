import { toErrorObject } from "../../infra/errors.js";

export const TERMINAL_OPEN_DEADLINE_MS = 30_000;

export class TerminalOpenDeadlineError extends Error {
  constructor() {
    super("terminal open timed out");
    this.name = "TerminalOpenDeadlineError";
  }
}

type TerminalOpenDeadline = {
  expiresAtMs: number;
  controller: AbortController;
};

export function createTerminalOpenDeadline(): TerminalOpenDeadline {
  return {
    expiresAtMs: Date.now() + TERMINAL_OPEN_DEADLINE_MS,
    controller: new AbortController(),
  };
}

function expireTerminalOpenDeadline(deadline: TerminalOpenDeadline): Error {
  if (!deadline.controller.signal.aborted) {
    deadline.controller.abort(new TerminalOpenDeadlineError());
  }
  return toErrorObject(deadline.controller.signal.reason, "Terminal open timed out");
}

export async function waitForTerminalOpenDeadline<T>(
  run: () => Promise<T>,
  deadline: TerminalOpenDeadline,
): Promise<T> {
  if (deadline.controller.signal.aborted || Date.now() >= deadline.expiresAtMs) {
    throw expireTerminalOpenDeadline(deadline);
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(expireTerminalOpenDeadline(deadline));
    };
    const timer = setTimeout(
      () => expireTerminalOpenDeadline(deadline),
      Math.max(0, deadline.expiresAtMs - Date.now()),
    );
    deadline.controller.signal.addEventListener("abort", onAbort, { once: true });
    let promise: Promise<T>;
    try {
      promise = run();
    } catch (error) {
      if (deadline.controller.signal.aborted || Date.now() >= deadline.expiresAtMs) {
        expireTerminalOpenDeadline(deadline);
        return;
      }
      clearTimeout(timer);
      deadline.controller.signal.removeEventListener("abort", onAbort);
      reject(toErrorObject(error, "Terminal open failed"));
      return;
    }
    void promise.then(
      (value) => {
        if (deadline.controller.signal.aborted || Date.now() >= deadline.expiresAtMs) {
          expireTerminalOpenDeadline(deadline);
          return;
        }
        clearTimeout(timer);
        deadline.controller.signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (deadline.controller.signal.aborted || Date.now() >= deadline.expiresAtMs) {
          expireTerminalOpenDeadline(deadline);
          return;
        }
        clearTimeout(timer);
        deadline.controller.signal.removeEventListener("abort", onAbort);
        reject(toErrorObject(error, "Terminal open failed"));
      },
    );
  });
}
