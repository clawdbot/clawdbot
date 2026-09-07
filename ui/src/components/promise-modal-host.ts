import { nothing, render } from "lit";
import "./modal-dialog.ts";

type PromiseModalHost<T> = {
  host: HTMLDivElement;
  finish: (value: T) => void;
  render: (content: () => unknown) => void;
  readonly settled: boolean;
};

/** Owns one imperative modal host; dismissal and reentrancy stay with its dialog. */
export function withPromiseModalHost<T>(
  abort: { signal?: AbortSignal; value: T } | undefined,
  initialize: (modal: PromiseModalHost<T>) => void,
): Promise<T> {
  if (abort?.signal?.aborted) {
    return Promise.resolve(abort.value);
  }
  const host = document.createElement("div");
  document.body.append(host);
  return new Promise((resolve) => {
    const modal = {
      host,
      settled: false,
      render(content: () => unknown) {
        if (!modal.settled) {
          render(content(), host);
        }
      },
      finish(value: T) {
        if (modal.settled) {
          return;
        }
        modal.settled = true;
        abort?.signal?.removeEventListener("abort", handleAbort);
        render(nothing, host);
        host.remove();
        resolve(value);
      },
    };
    const handleAbort = () => abort && modal.finish(abort.value);
    abort?.signal?.addEventListener("abort", handleAbort, { once: true });
    initialize(modal);
  });
}
