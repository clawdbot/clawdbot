// Slack test API exposes QA runtime operations from the owning plugin.
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

export {
  createSlackWebClient,
  createSlackWriteClient,
  resolveSlackWebClientOptions,
} from "./src/client.js";

type SlackActions = typeof import("./src/actions.js");

// Async imports keep Jiti from resolving the action graph on one deep synchronous stack.
const loadSlackActions = createLazyRuntimeModule(() => import("./src/actions.js"));

/**
 * Warm the lazily imported action graph as suite preparation. The first
 * action call otherwise pays the cold import inside a Vitest test deadline.
 */
export const preloadSlackActions = async (): Promise<void> => {
  await loadSlackActions();
};

export const listSlackReactions: SlackActions["listSlackReactions"] = async (...args) =>
  (await loadSlackActions()).listSlackReactions(...args);
export const sendSlackMessage: SlackActions["sendSlackMessage"] = async (...args) =>
  (await loadSlackActions()).sendSlackMessage(...args);
