// Groq plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
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
    });
    api.registerMediaUnderstandingProvider(groqMediaUnderstandingProvider);
  },
});
