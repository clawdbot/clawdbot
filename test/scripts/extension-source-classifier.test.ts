import { describe, expect, it } from "vitest";
import { classifyBundledExtensionSourcePath } from "../../scripts/lib/extension-source-classifier.mjs";

function expectClassification(
  filePath: string,
  expected: {
    isCodeFile: boolean;
    isRuntimeApiBarrel: boolean;
    isPublicApiBarrel: boolean;
    isTestLike: boolean;
    isInfraArtifact: boolean;
    isProductionSource: boolean;
  },
) {
  expect(classifyBundledExtensionSourcePath(filePath)).toEqual({
    normalizedPath: filePath,
    ...expected,
  });
}

describe("classifyBundledExtensionSourcePath", () => {
  it("treats runtime barrels as non-production source", () => {
    expectClassification("extensions/msteams/runtime-api.ts", {
      isCodeFile: true,
      isRuntimeApiBarrel: true,
      isPublicApiBarrel: false,
      isTestLike: false,
      isInfraArtifact: false,
      isProductionSource: false,
    });
  });

  it("treats extension tests and fixtures as test-like across naming styles", () => {
    expectClassification("extensions/feishu/src/monitor-handler.test.ts", {
      isCodeFile: true,
      isRuntimeApiBarrel: false,
      isPublicApiBarrel: false,
      isTestLike: true,
      isInfraArtifact: false,
      isProductionSource: false,
    });
    expectClassification("extensions/discord/src/test-fixtures/message.ts", {
      isCodeFile: true,
      isRuntimeApiBarrel: false,
      isPublicApiBarrel: false,
      isTestLike: true,
      isInfraArtifact: false,
      isProductionSource: false,
    });
    expectClassification("extensions/telegram/src/bot.test-harness.ts", {
      isCodeFile: true,
      isRuntimeApiBarrel: false,
      isPublicApiBarrel: false,
      isTestLike: true,
      isInfraArtifact: false,
      isProductionSource: false,
    });
    expectClassification("extensions/telegram/src/target-writeback.test-shared.ts", {
      isCodeFile: true,
      isRuntimeApiBarrel: false,
      isPublicApiBarrel: false,
      isTestLike: true,
      isInfraArtifact: false,
      isProductionSource: false,
    });
  });

  it("keeps normal extension production files eligible for guardrails", () => {
    expectClassification("extensions/msteams/src/send.ts", {
      isCodeFile: true,
      isRuntimeApiBarrel: false,
      isPublicApiBarrel: false,
      isTestLike: false,
      isInfraArtifact: false,
      isProductionSource: true,
    });
  });
});
