import { describe, expect, it } from "vitest";
import plugin from "../index.js";

/**
 * `openclaw dashboard` is a core command (it opens the Control UI). A plugin CLI
 * group whose name overlaps a core command is skipped at registration, and the
 * skip is only a `logger.debug` line — so the whole CLI face of this plugin
 * silently disappears at runtime while its unit tests, which build their own
 * Commander program, keep passing.
 *
 * This test pins the name that made the CLI reachable.
 */
describe("Workspaces plugin CLI registration", () => {
  it("does not claim a command name core already owns", () => {
    const descriptorNames: string[] = [];
    const api = {
      registerCli: (_register: unknown, options?: { descriptors?: Array<{ name: string }> }) => {
        for (const descriptor of options?.descriptors ?? []) {
          descriptorNames.push(descriptor.name);
        }
      },
      registerGatewayMethod: () => {},
      registerTool: () => {},
      registerHttpRoute: () => {},
      session: { controls: { registerControlUiDescriptor: () => {} } },
    };

    plugin.register(api as never);

    expect(descriptorNames).toEqual(["workspaces"]);
    // Names reserved by `src/cli/program/command-registry-core.ts`.
    expect(descriptorNames).not.toContain("dashboard");
    expect(descriptorNames).not.toContain("doctor");
  });
});
