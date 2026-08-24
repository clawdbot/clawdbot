/**
 * Canvas CLI metadata entrypoint used for lightweight command discovery.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "canvas",
  name: "Canvas",
  description: "Presents hosted widget documents on paired macOS panels.",
  register(api) {
    api.registerNodeCliFeature(() => {}, {
      descriptors: [
        {
          name: "canvas",
          description: "Present widget documents on a paired macOS panel",
          hasSubcommands: true,
        },
      ],
    });
  },
});
