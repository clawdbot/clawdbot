import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { contributeGroqResolvedModelCompat } from "./api.js";
import { groqMediaUnderstandingProvider } from "./media-understanding-provider.js";

export default definePluginEntry({
  id: "groq",
  name: "Groq Provider",
  description: "Bundled Groq provider plugin",
  register(api) {
    api.registerProvider({
      id: "groq",
      label: "Groq",
      docsPath: "/providers/groq",
      envVars: ["GROQ_API_KEY"],
      auth: [],
      contributeResolvedModelCompat: ({ modelId, model }) =>
        contributeGroqResolvedModelCompat({ modelId, model }),
    });
    api.registerMediaUnderstandingProvider(groqMediaUnderstandingProvider);
  },
});
