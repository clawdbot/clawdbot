// QA Lab resolves Slack operations from the owning plugin's isolated dependency scope.
import type { SlackQaRuntime } from "@openclaw/slack/test-api.js";
import { loadQaRunnerBundledPluginTestApi } from "openclaw/plugin-sdk/qa-runner-runtime";

type SlackQaTestApi = {
  slackQaRuntime: SlackQaRuntime;
};

let cachedSlackQaRuntime: SlackQaRuntime | undefined;

export function loadSlackQaRuntime(): SlackQaRuntime {
  cachedSlackQaRuntime ??= loadQaRunnerBundledPluginTestApi<SlackQaTestApi>("slack").slackQaRuntime;
  return cachedSlackQaRuntime;
}
