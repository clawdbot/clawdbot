/**
 * Backgrounded exec must carry its follow-up route in the structured value.
 *
 * Code Mode hands the guest `details` only (`code-mode-bridge.ts`), never `content`,
 * so guidance that lives solely in the visible text is invisible from inside a run.
 * That is how a backgrounded session reads as a dead end and gets abandoned.
 */
import { afterEach, expect, test } from "vitest";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { processSchema } from "./bash-tools.schemas.js";

afterEach(() => {
  resetProcessRegistryForTests();
});

test("a backgrounded run exposes its process follow-up route in details, not only in text", async () => {
  const exec = createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    allowBackground: true,
    backgroundMs: 0,
    scopeKey: "agent:main:followup-proof",
  });

  const result = await exec.execute("background-followup", {
    command: `node -e "setTimeout(() => {}, 2000)"`,
    background: true,
  });

  const details = result.details as { status?: string; sessionId?: string; followUp?: string };
  expect(details.status).toBe("running");
  expect(details.sessionId).toEqual(expect.any(String));

  // The guest value alone must name the recovery surface.
  const followUp = details.followUp ?? "";
  expect(followUp).toContain("process");

  // Bind the advertised actions to the real process schema so this cannot rot into
  // guidance that names an action the tool does not implement.
  const processActions = (processSchema.properties.action as { enum?: string[] }).enum ?? [];
  const advertised = /process \(([^)]+)\)/.exec(followUp)?.[1]?.split("/") ?? [];
  expect(advertised.length).toBeGreaterThan(0);
  for (const action of advertised) {
    expect(processActions).toContain(action);
  }

  // The visible text keeps the same route, so the two surfaces cannot drift.
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((block) => block.text ?? "")
    .join("");
  expect(text).toContain(followUp);
});
