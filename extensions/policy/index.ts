// Policy plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerPolicyCli } from "./src/cli.js";
import { registerPolicyDoctorChecks } from "./src/doctor/register.js";

export default definePluginEntry({
  id: "policy",
  name: "Policy",
  description: "Adds policy-backed doctor checks for workspace conformance.",
  register(api) {
    api.registerCli(
      async ({ program }) => {
        registerPolicyCli(program);
      },
      {
        descriptors: [
          {
            name: "policy",
            description: "Check policy requirements and emit audit evidence",
            hasSubcommands: true,
          },
        ],
      },
    );
    registerPolicyDoctorChecks();
  },
});
