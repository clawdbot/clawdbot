import { definePluginEntry } from "./runtime-api.js";
import { registerQaLabCli } from "./src/cli.js";

export default definePluginEntry({
  id: "qa-lab",
  name: "QA Lab",
  description: "Private QA automation harness and debugger UI",
  register(api) {
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
