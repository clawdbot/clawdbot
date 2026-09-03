// QA Lab tests cover the Slack plugin runtime facade.
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadQaRunnerBundledPluginTestApi = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/qa-runner-runtime", () => ({
  loadQaRunnerBundledPluginTestApi,
}));

describe("Slack plugin runtime facade", () => {
  beforeEach(() => {
    vi.resetModules();
    loadQaRunnerBundledPluginTestApi.mockReset();
  });

  it("loads the Slack test API once and reuses its namespaced runtime", async () => {
    const slackQaRuntime = {
      createSlackWebClient: vi.fn(),
      createSlackWriteClient: vi.fn(),
      listSlackReactions: vi.fn(),
      resolveSlackWebClientOptions: vi.fn(),
      sendSlackMessage: vi.fn(),
    };
    loadQaRunnerBundledPluginTestApi.mockReturnValue(slackQaRuntime);

    const { loadSlackQaRuntime } = await import("./slack-plugin.runtime.js");

    expect(loadSlackQaRuntime()).toBe(slackQaRuntime);
    expect(loadSlackQaRuntime()).toBe(slackQaRuntime);
    expect(loadQaRunnerBundledPluginTestApi).toHaveBeenCalledExactlyOnceWith("slack");
  });
});
