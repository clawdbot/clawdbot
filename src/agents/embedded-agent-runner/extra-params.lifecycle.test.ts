import { describe, expect, it } from "vitest";
import type { Model, SimpleStreamOptions } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import {
  attachModelProviderRuntimePluginHandle,
  type ProviderRuntimePluginHandle,
} from "../../plugins/provider-hook-runtime.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { applyExtraParamsToAgent, resolvePreparedExtraParams } from "./extra-params.js";

describe("prepared provider extra-param lifecycle", () => {
  it("uses each prepared owner for params and stream wrapping with shared config", () => {
    const cfg = { agents: { defaults: { params: { temperature: 0.1 } } } };
    const model = makeProviderModelFixture({
      provider: "fixture-provider",
      id: "fixture-model",
      api: "fixture-api",
      baseUrl: "https://fixture.invalid",
    });
    const observed: Array<SimpleStreamOptions | undefined> = [];
    for (const owner of ["first", "replacement", "updated"]) {
      if (owner === "updated") {
        cfg.agents.defaults.params.temperature = 0.7;
      }
      const plugin: ProviderPlugin = {
        id: model.provider,
        label: "Fixture",
        auth: [],
        prepareExtraParams: ({ extraParams }) => ({ ...extraParams, owner }),
        extraParamsForTransport: ({ extraParams }) => ({
          patch: { preparedBy: extraParams.owner },
        }),
        wrapStreamFn:
          ({ streamFn, extraParams }) =>
          (requestModel, context, options) =>
            streamFn!(requestModel, context, {
              ...options,
              headers: { owner, preparedBy: String(extraParams?.preparedBy) },
            }),
      };
      const providerRuntimeHandle: ProviderRuntimePluginHandle = {
        provider: model.provider,
        modelId: model.id,
        config: cfg,
        plugin,
      };
      const preparedExtraParams = resolvePreparedExtraParams({
        cfg,
        provider: model.provider,
        modelId: model.id,
        providerRuntimeHandle,
      });
      const agent = {
        streamFn: (_model: Model, _context: unknown, options?: SimpleStreamOptions) => {
          observed.push(options);
          return createAssistantMessageEventStream();
        },
      };
      const preparedModel = attachModelProviderRuntimePluginHandle(model, providerRuntimeHandle);
      applyExtraParamsToAgent(
        agent,
        cfg,
        model.provider,
        model.id,
        undefined,
        undefined,
        undefined,
        undefined,
        preparedModel,
        undefined,
        undefined,
        { preparedExtraParams },
      );
      agent.streamFn(model, { messages: [] });
    }
    expect(
      observed.map((options) => ({ temperature: options?.temperature, headers: options?.headers })),
    ).toEqual([
      { temperature: 0.1, headers: { owner: "first", preparedBy: "first" } },
      { temperature: 0.1, headers: { owner: "replacement", preparedBy: "replacement" } },
      { temperature: 0.7, headers: { owner: "updated", preparedBy: "updated" } },
    ]);
  });
});
