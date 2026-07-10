import { describe, expect, it } from "vitest";
import {
  MAX_PRIVATE_QA_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES,
  MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES,
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
    expect(
      evaluatePluginSdkDeclarationBudget({
        buildPrivateQa: false,
        declarationBytes: MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES,
      }),
    ).toEqual({
      budgetBytes: MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES,
      budgetKind: "public",
      shouldFail: false,
    });
    expect(
      evaluatePluginSdkDeclarationBudget({
        buildPrivateQa: false,
        declarationBytes: MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES + 1,
      }),
    ).toEqual({
      budgetBytes: MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES,
      budgetKind: "public",
      shouldFail: true,
    });
  });

  it("tracks private-build public-entry chunk growth under a separate budget", () => {
    expect(
      evaluatePluginSdkDeclarationBudget({
        buildPrivateQa: true,
        declarationBytes: MAX_PRIVATE_QA_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES,
      }),
    ).toEqual({
      budgetBytes: MAX_PRIVATE_QA_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES,
      budgetKind: "private-qa-public-entry",
      shouldFail: false,
    });
    expect(
      evaluatePluginSdkDeclarationBudget({
        buildPrivateQa: true,
        declarationBytes: MAX_PRIVATE_QA_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES + 1,
      }),
    ).toEqual({
      budgetBytes: MAX_PRIVATE_QA_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES,
      budgetKind: "private-qa-public-entry",
      shouldFail: true,
    });
  });
});
