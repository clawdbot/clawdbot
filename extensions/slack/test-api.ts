// Slack test API exposes QA runtime operations from the owning plugin.
import { listSlackReactions, sendSlackMessage } from "./src/actions.js";
import {
  createSlackWebClient,
  createSlackWriteClient,
  resolveSlackWebClientOptions,
} from "./src/client.js";

export const slackQaRuntime = {
  createSlackWebClient,
  createSlackWriteClient,
  listSlackReactions,
  resolveSlackWebClientOptions,
  sendSlackMessage,
};
export type SlackQaRuntime = typeof slackQaRuntime;
