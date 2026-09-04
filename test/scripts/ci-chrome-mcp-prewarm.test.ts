import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { resolveChangedTestTargetPlan } from "../../scripts/test-projects.test-support.mts";

type WorkflowStep = {
  name: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};

it.each([".github/workflows/ci.yml", "extensions/browser/src/browser/chrome-mcp-options.ts"])(
  "selects the prewarm contract when %s changes",
  (changedPath) => {
    expect(resolveChangedTestTargetPlan([changedPath])).toMatchObject({
      mode: "targets",
      targets: expect.arrayContaining(["test/scripts/ci-chrome-mcp-prewarm.test.ts"]),
    });
  },
);

it("prewarms the runtime's pinned Chrome MCP package before offline browser E2E", () => {
  // The private runtime constants are the independent contract, not another test pin.
  const options = readFileSync("extensions/browser/src/browser/chrome-mcp-options.ts", "utf8");
  const command = options.match(/const DEFAULT_CHROME_MCP_COMMAND = "([^"]+)";/)?.[1];
  const packageArgs = JSON.parse(
    options.match(/const DEFAULT_CHROME_MCP_PACKAGE_ARGS = (\[[^\]]+\]);/)?.[1] ?? "null",
  ) as string[];
  expect(command).toBe("npx");
  expect(packageArgs.slice(0, -1)).toEqual(["-y", "--audit=false"]);
  const packageSpec = packageArgs.at(-1)!;
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const steps = workflow.jobs["checks-ui-e2e"].steps as WorkflowStep[];
  const restore = steps.findIndex((step) => step.name === "Restore Chrome MCP npm cache");
  const warm = steps.findIndex((step) => step.name === "Pre-warm Chrome MCP");
  const save = steps.findIndex((step) => step.name === "Save Chrome MCP npm cache");
  const offline = steps.findIndex((step) => step.name === "Configure offline Chrome MCP");
  const test = steps.findIndex(
    (step) => step.name === "Test browser extension bootstrap end-to-end",
  );

  expect(restore).toBeGreaterThan(-1);
  expect(warm).toBeGreaterThan(restore);
  expect(save).toBeGreaterThan(warm);
  expect(offline).toBeGreaterThan(save);
  expect(test).toBeGreaterThan(offline);
  expect(steps[restore]).toMatchObject({
    id: "chrome-mcp-cache",
    if: "matrix.task == 'browser-extension' && needs.preflight.outputs.cache_mode != 'off'",
    uses: expect.stringMatching(/^actions\/cache\/restore@/),
    with: {
      path: "~/.npm/_cacache\n~/.npm/_npx\n",
      key: `\${{ runner.os }}-\${{ runner.arch }}-${packageSpec}-node24-v1`,
    },
  });
  expect(steps[warm]).toMatchObject({
    if: "matrix.task == 'browser-extension' && steps.chrome-mcp-cache.outputs.cache-hit != 'true'",
    run: `${command} ${packageArgs.join(" ")} --version`,
  });
  expect(steps[save]).toMatchObject({
    if: "matrix.task == 'browser-extension' && needs.preflight.outputs.cache_write_allowed == 'true' && steps.chrome-mcp-cache.outputs.cache-hit != 'true'",
    uses: expect.stringMatching(/^actions\/cache\/save@/),
    with: steps[restore]!.with,
  });
  expect(steps[offline]).toMatchObject({
    if: "matrix.task == 'browser-extension'",
    run: 'npm config set cache="$HOME/.npm" offline=true --location=project',
  });
});
