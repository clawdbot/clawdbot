import type { Api, Model } from "@mariozechner/pi-ai";

function isOpenAiCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  if (!isOpenAiCompletionsModel(model)) return model;

  const baseUrl = model.baseUrl ?? "";
  const isZai = model.provider === "zai" || baseUrl.includes("api.z.ai");
  const isOvhcloud = model.provider === "ovhcloud" || baseUrl.includes("ovh.net");
  if (!isZai && !isOvhcloud) return model;

  const openaiModel = model as Model<"openai-completions">;
  const compat = openaiModel.compat ?? undefined;

  if (isZai) {
    if (compat?.supportsDeveloperRole === false) return model;
    openaiModel.compat = compat
      ? { ...compat, supportsDeveloperRole: false }
      : { supportsDeveloperRole: false };
  }

  if (isOvhcloud) {
    if (compat?.supportsStore === false) return model;
    openaiModel.compat = compat ? { ...compat, supportsStore: false } : { supportsStore: false };
  }

  return openaiModel;
}
