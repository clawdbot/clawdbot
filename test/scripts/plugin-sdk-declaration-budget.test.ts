import { describe, expect, it } from "vitest";
import {
  MAX_PRIVATE_QA_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES,
  MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES,
  PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES,
  evaluatePluginSdkDeclarationBudget,
  isPrivateQaPluginSdkBuild,
} from "../../scripts/lib/plugin-sdk-declaration-budget.mjs";

describe("plugin SDK declaration budget", () => {
  it("selects private QA mode only for the explicit build flag", () => {
    expect(isPrivateQaPluginSdkBuild({})).toBe(false);
    expect(isPrivateQaPluginSdkBuild({ OPENCLAW_BUILD_PRIVATE_QA: "0" })).toBe(false);
    expect(isPrivateQaPluginSdkBuild({ OPENCLAW_BUILD_PRIVATE_QA: "1" })).toBe(true);
  });

  it("enforces the publication budget at its exact boundary", () => {
    const budgetBytes =
      MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES + PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES;
    expect(
      evaluatePluginSdkDeclarationBudget({
        buildPrivateQa: false,
        declarationBytes: budgetBytes,
      }),
    ).toEqual({
      budgetBytes,
      budgetKind: "public",
      ratchetBytes: MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES,
      shouldFail: false,
      varianceBytes: PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES,
    });
    expect(
      evaluatePluginSdkDeclarationBudget({
        buildPrivateQa: false,
        declarationBytes: budgetBytes + 1,
      }),
    ).toEqual({
      budgetBytes,
      budgetKind: "public",
      ratchetBytes: MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES,
      shouldFail: true,
      varianceBytes: PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES,
    });
  });

  it("tracks private-build public-entry chunk growth under a separate budget", () => {
    const budgetBytes =
      MAX_PRIVATE_QA_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES +
      PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES;
    expect(
      evaluatePluginSdkDeclarationBudget({
        buildPrivateQa: true,
        declarationBytes: budgetBytes,
      }),
    ).toEqual({
      budgetBytes,
      budgetKind: "private-qa-public-entry",
      ratchetBytes: MAX_PRIVATE_QA_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES,
      shouldFail: false,
      varianceBytes: PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES,
    });
    expect(
      evaluatePluginSdkDeclarationBudget({
        buildPrivateQa: true,
        declarationBytes: budgetBytes + 1,
      }),
    ).toEqual({
      budgetBytes,
      budgetKind: "private-qa-public-entry",
      ratchetBytes: MAX_PRIVATE_QA_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES,
      shouldFail: true,
      varianceBytes: PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES,
    });
  });
});
