import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "canvas",
  name: "Canvas",
  description: "Experimental Canvas control and A2UI rendering surfaces for paired nodes.",
  register(api) {
    api.registerNodeCliFeature(() => {}, {
      descriptors: [
        {
          name: "canvas",
          description: "Capture or render canvas content from a paired node",
          hasSubcommands: true,
        },
      ],
    });
  },
});
