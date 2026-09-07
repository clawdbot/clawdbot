// Github Copilot tests cover provider runtime.contract plugin behavior.
import { describeGithubCopilotProviderRuntimeContract } from "openclaw/plugin-sdk/provider-test-contracts";
import { expect, it } from "vitest";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describeGithubCopilotProviderRuntimeContract(
  () => import("./index.js"),
  manifest.modelCatalog.providers["github-copilot"],
);

it("does not advertise live-only models through the static fallback catalog", () => {
  expect(
    manifest.modelCatalog.providers["github-copilot"].models.map((model) => model.id),
  ).not.toContain("raptor-mini");
});
