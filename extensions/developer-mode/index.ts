import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const common = {
  controlLabel: "Tool mode",
} as const;

export default definePluginEntry({
  id: "developer-mode",
  name: "Developer Mode",
  description: "Per-session Tool modes for the OpenClaw runtime.",
  register(api) {
    api.session.controls.registerToolMode({
      ...common,
      id: "standard",
      label: "Standard",
      description: "Best for most work",
      default: true,
      toolProfile: "coding",
      codeMode: "direct",
    });
    api.session.controls.registerToolMode({
      ...common,
      id: "code",
      label: "Code",
      description: "Combine several actions efficiently",
      toolProfile: "coding",
      codeMode: "code",
    });
    api.session.controls.registerToolMode({
      ...common,
      id: "minimal",
      label: "Minimal",
      description: "Use a smaller, focused toolset",
      toolProfile: "minimal",
      codeMode: "direct",
    });
  },
});
