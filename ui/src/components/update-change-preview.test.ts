import { render } from "lit";
import { afterEach, expect, it } from "vitest";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { renderUpdateChangePreview } from "./update-change-preview.ts";

const update: UpdateAvailable = {
  channel: "dev",
  currentVersion: "1.0.0",
  latestVersion: "1.0.0",
  currentSha: "1111111",
  upstreamSha: "abcdef0",
  commitsBehind: 6,
  commits: Array.from({ length: 5 }, (_, index) => ({
    sha: `abc123${index}`,
    subject: index === 0 ? "fix: <img src=x onerror=alert(1)>" : `docs: change ${index}`,
  })),
};

function preview(value: UpdateAvailable | null, schedule: UpdateScheduleState | null = null) {
  const host = document.createElement("div");
  document.body.append(host);
  render(renderUpdateChangePreview(value, schedule), host);
  return host;
}

afterEach(() => document.body.replaceChildren());

it("labels a partial preview and renders all subjects as text, including docs", () => {
  const host = preview(update);
  expect(host.textContent).toContain("Showing 5 of 6 commits");
  expect(host.querySelectorAll("li")).toHaveLength(5);
  expect(host.textContent).toContain("fix: <img src=x onerror=alert(1)>");
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).toContain("docs: change 4");
});

it("does not call a complete preview partial", () => {
  expect(preview({ ...update, commitsBehind: 5 }).textContent).not.toContain("Showing");
});

it.each([null, { ...update, commits: [] }, { ...update, commits: undefined }])(
  "omits unavailable metadata without inventing release notes",
  (value) => expect(preview(value).querySelector("section")).toBeNull(),
);

it.each([
  { target: { kind: "package", version: "2.0.0" } },
  { target: { kind: "git", commitsBehind: 7, upstreamSha: "abcdef0" } },
  { target: { kind: "git", commitsBehind: 6, upstreamSha: "fffffff" } },
  { install: { kind: "git", git: { status: "current" } } },
  { install: { kind: "git", git: { status: "behind", commitsBehind: 7 } } },
  {
    install: { kind: "git", git: { status: "behind", commitsBehind: 6, currentSha: "2222222" } },
  },
])("hides previews contradicted by the current comparison: %j", (schedule) => {
  expect(
    preview(update, schedule as unknown as UpdateScheduleState).querySelector("section"),
  ).toBeNull();
});

it("hides commits when there is no git update to review", () => {
  expect(preview({ ...update, commitsBehind: 0 }).querySelector("section")).toBeNull();
});
