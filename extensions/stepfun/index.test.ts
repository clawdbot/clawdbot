// Stepfun tests cover index plugin behavior.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import stepfunPlugin from "./index.js";

type StepFunManifest = {
  setup?: {
    providers?: Array<{
      id?: string;
      authMethods?: string[];
      envVars?: string[];
    }>;
  };
  providerAuthChoices?: Array<{
    provider?: string;
    method?: string;
    choiceId?: string;
  }>;
};

function readManifest(): StepFunManifest {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, "openclaw.plugin.json"), "utf-8"));
}

describe("stepfun provider registration", () => {
  it("keeps manifest auth choices aligned with runtime provider methods", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: stepfunPlugin,
      id: "stepfun",
      name: "StepFun",
    });
    const manifest = readManifest();
    const runtimeChoices = ["stepfun", "stepfun-plan"].flatMap((providerId) => {
      const provider = requireRegisteredProvider(providers, providerId);
      return provider.auth.map((method) => ({
        provider: provider.id,
        method: method.id,
        choiceId: method.wizard?.choiceId,
      }));
    });

    const manifestChoices = manifest.providerAuthChoices?.map((choice) => ({
      provider: choice.provider,
      method: choice.method,
      choiceId: choice.choiceId,
    }));

    expect(runtimeChoices).toEqual(manifestChoices);
    expect(manifest.setup?.providers).toEqual([
      {
        id: "stepfun",
        envVars: ["STEPFUN_API_KEY"],
      },
      {
        id: "stepfun-plan",
        envVars: ["STEPFUN_API_KEY"],
      },
    ]);
  });
});
