import { render } from "lit";
import { expect, it } from "vitest";
import type { CronJob } from "../../api/types.ts";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import { renderAgents } from "./view.ts";

it.each([true, false])("links agent automations to the shared editor (enabled=%s)", (enabled) => {
  const container = document.createElement("div");
  const job: CronJob = {
    id: "job /?&",
    name: "Weekly report",
    agentId: "alpha",
    enabled,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Summarize notes." },
    state: {},
  };
  const props = createProps({
    activePanel: "cron",
    selectedAgentId: "alpha",
    basePath: "/gateway",
  });
  render(renderAgents({ ...props, cron: { ...props.cron, jobs: [job] } }), container);
  const link = [...container.querySelectorAll("a")].find(
    (entry) => entry.textContent?.trim() === "Edit",
  );
  expect(link?.getAttribute("href")).toBe("/gateway/automations?job=job%20%2F%3F%26");
});
