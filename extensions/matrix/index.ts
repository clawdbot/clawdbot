import type { ClawdbotPluginApi } from "../../src/plugins/types.js";

import { matrixPlugin } from "./src/channel.js";

const plugin = {
  id: "matrix",
  name: "Matrix",
  description: "Matrix channel plugin (matrix-js-sdk)",
  register(api: ClawdbotPluginApi) {
    api.registerChannel({ plugin: matrixPlugin });
  },
};

export default plugin;
