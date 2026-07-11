// Qa Lab plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "./runtime-api.js";
import { registerQaLabCli } from "./src/cli.js";
import { createQaLabWebSearchProvider } from "./src/qa-web-search-provider.js";
import { createStaticSshWorkerProvider } from "./src/static-ssh-worker-provider.js";

export default definePluginEntry({
  id: "qa-lab",
  name: "QA Lab",
  description: "Private QA automation harness and debugger UI",
  register(api) {
    api.registerWorkerProvider(createStaticSshWorkerProvider());
    api.registerWebSearchProvider(createQaLabWebSearchProvider());
    api.registerCli(
      async ({ program }) => {
        registerQaLabCli(program);
      },
      {
        descriptors: [
          {
            name: "qa",
            description: "Run QA scenarios and launch the private QA debugger UI",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
