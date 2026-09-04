import { describe, expect, it } from "vitest";
import { buildChatAttachmentHistory } from "../../scripts/control-ui-mock-attachments.ts";
import { buildBackgroundTasksMock } from "../../scripts/control-ui-mock-background-tasks.ts";
import { buildCronMocks } from "../../scripts/control-ui-mock-cron.ts";
import {
  buildPluginCatalogMock,
  buildPluginLifecycleMocks,
} from "../../scripts/control-ui-mock-plugins.ts";
import { buildSkillWorkshopMocks } from "../../scripts/control-ui-mock-skill-workshop.ts";

const BASE_TIME = Date.parse("2026-05-22T09:00:00.000Z");

describe("Control UI mock surface fixtures", () => {
  it("keeps attachment media deep enough to exercise virtualized remounts", () => {
    const history = buildChatAttachmentHistory(BASE_TIME) as Array<{
      content?: Array<{ type?: string }>;
    }>;

    expect(history.length).toBeGreaterThan(40);
    expect(history.flatMap((message) => message.content ?? [])).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "image" })]),
    );
  });

  it("serves the active and recent task queries issued by the chat task panels", () => {
    const mock = buildBackgroundTasksMock(BASE_TIME);
    const cases = mock.methodResponses["tasks.list"].cases;
    const active = cases.find(
      (entry) => entry.match && "status" in entry.match && entry.match.status[0] === "queued",
    );
    const recent = cases.find(
      (entry) => entry.match && "sortBy" in entry.match && entry.match.sortBy === "endedAt",
    );

    expect(active?.response.tasks.map((task) => task.status)).toEqual([
      "queued",
      "running",
      "running",
    ]);
    expect(recent?.response.tasks.map((task) => task.status)).toEqual(
      expect.arrayContaining(["completed", "failed", "cancelled", "timed_out"]),
    );
    expect(mock.methodResponses["tasks.cancel"].cases).toHaveLength(8);
  });

  it("represents current cron failure alerts and intentional delivery suppression", () => {
    const mocks = buildCronMocks(BASE_TIME);
    const jobs = mocks["cron.list"].cases.at(-1)?.response.jobs ?? [];
    const runs = mocks["cron.runs"].cases.at(-1)?.response.entries ?? [];

    expect(jobs).toEqual(
      expect.arrayContaining([expect.objectContaining({ failureAlert: expect.any(Object) })]),
    );
    expect(runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ deliverySuppressionReason: expect.any(String) }),
      ]),
    );
  });

  it("keeps install, enable, and remove interactions reachable from plugin fixtures", () => {
    const lifecycle = buildPluginLifecycleMocks();

    expect(buildPluginCatalogMock().plugins.some((plugin) => !plugin.installed)).toBe(true);
    expect(lifecycle.install.cases.map((entry) => entry.match.pluginId)).toEqual([
      "browser",
      "canvas",
    ]);
    expect(lifecycle.uninstall.cases[0]?.response).toMatchObject({
      ok: true,
      pluginId: "discord",
      restartRequired: true,
    });
  });

  it("serves every current Skill Workshop lifecycle action", () => {
    const mocks = buildSkillWorkshopMocks(BASE_TIME);
    const firstInspect = mocks.inspect.cases[0]?.response;

    expect(firstInspect).toMatchObject({ revisionHash: "b".repeat(64) });
    expect(mocks.evaluate.cases).toHaveLength(3);
    expect(mocks.apply.cases).toHaveLength(3);
    expect(mocks.reject.cases).toHaveLength(3);
    expect(mocks.requestRevision).toEqual({
      runId: "skill-workshop-revision-mock",
      status: "started",
    });
  });
});
