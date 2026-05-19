import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export function createNonInteractiveLoggingPrompter(
  runtime: RuntimeEnv,
  formatPromptError: (message: string) => string,
): WizardPrompter {
  const unavailable = <T>(message: string): Promise<T> =>
    Promise.reject(new Error(formatPromptError(message)));
  return {
    async intro(title) {
      runtime.log(title);
    },
    async outro(message) {
      runtime.log(message);
    },
    async note(message, title) {
      runtime.log(title ? `${title}\n${message}` : message);
    },
    async select(params) {
      return unavailable(params.message);
    },
    async multiselect(params) {
      return unavailable(params.message);
    },
    async text(params) {
      return unavailable(params.message);
    },
    async confirm(params) {
      return unavailable(params.message);
    },
    progress(label) {
      runtime.log(label);
      return {
        update(message) {
          runtime.log(message);
        },
        stop(message) {
          if (message) {
            runtime.log(message);
          }
        },
      };
    },
  };
}
