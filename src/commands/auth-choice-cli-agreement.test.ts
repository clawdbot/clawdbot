// Pins the contract that onboard help advertises exactly the auth choices the
// non-interactive dispatcher accepts, so the two lists cannot drift apart.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const PROVIDER_SETUP_CONTRIBUTIONS = [
  { providerId: "demo", option: { value: "demo-api-key", label: "Demo API key" } },
  { providerId: "demo", option: { value: "demo-cli", label: "Demo CLI" } },
];

vi.mock("../flows/provider-flow.js", () => ({
  resolveProviderSetupFlowContributions: () => PROVIDER_SETUP_CONTRIBUTIONS,
}));

// "claude-cli" is the one deprecated alias `auth-choice-legacy.ts` recognizes,
// so reproducing the advertised-but-rejected case needs that exact id. It is
// normalized to its replacement before any CLI list is consulted, which is why
// neither list may contain it.
const DEPRECATED_ALIAS = "claude-cli";

vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveProviderOnboardAuthFlags: () => [],
  resolveManifestProviderAuthChoices: () => [
    {
      pluginId: "demo",
      providerId: "demo",
      methodId: "cli",
      choiceId: "demo-cli",
      choiceLabel: "Demo CLI",
      deprecatedChoiceIds: [DEPRECATED_ALIAS],
    },
  ],
  resolveManifestDeprecatedProviderAuthChoice: (choiceId: string) =>
    choiceId === DEPRECATED_ALIAS
      ? { choiceId: "demo-cli", choiceLabel: "Demo CLI", providerId: "demo" }
      : undefined,
}));

vi.mock("../plugins/provider-install-catalog.js", () => ({
  resolveDeprecatedProviderInstallCatalogEntry: () => undefined,
}));

vi.mock("./onboard-non-interactive/local/auth-choice.plugin-providers.js", () => ({
  applyNonInteractivePluginProviderChoice: async () => undefined,
}));

vi.mock("./onboard-recommendations.js", () => ({
  acknowledgeOnboardRecommendationsCommand: vi.fn(),
  onboardRecommendationsCommand: vi.fn(),
  refreshOnboardRecommendationsCommand: vi.fn(),
}));

async function readHelpAuthChoices(): Promise<string[]> {
  const { registerOnboardCommand } = await import("../cli/program/register.onboard.js");
  const program = new Command();
  registerOnboardCommand(program);
  const onboard = program.commands.find((command) => command.name() === "onboard");
  const description = onboard?.options.find(
    (option) => option.long === "--auth-choice",
  )?.description;
  if (!description?.startsWith("Auth: ")) {
    throw new Error(`unexpected --auth-choice help text: ${String(description)}`);
  }
  return description.slice("Auth: ".length).split("|");
}

async function readAcceptedAuthChoices(rejectedChoice: string): Promise<string[]> {
  const { applyNonInteractiveAuthChoice } =
    await import("./onboard-non-interactive/local/auth-choice.js");
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const result = await applyNonInteractiveAuthChoice({
    nextConfig: {} as OpenClawConfig,
    authChoice: rejectedChoice,
    opts: {},
    runtime: runtime as never,
    baseConfig: {} as OpenClawConfig,
    target: { agentId: "main", agentDir: "/tmp/agent", workspaceDir: "/tmp/workspace" },
  });
  expect(result).toBeNull();
  expect(runtime.exit).toHaveBeenCalledWith(1);
  const message = runtime.error.mock.calls.at(0)?.at(0);
  const listed = /Valid choices: (.*)\.$/.exec(String(message))?.[1];
  if (!listed) {
    throw new Error(`unexpected rejection message: ${String(message)}`);
  }
  return listed.split(", ");
}

describe("onboard --auth-choice help and validation agreement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("advertises exactly the choices the non-interactive dispatcher accepts", async () => {
    const help = await readHelpAuthChoices();
    const accepted = await readAcceptedAuthChoices("definitely-not-an-auth-choice");

    expect([...help].toSorted()).toEqual([...accepted].toSorted());
    // Guard against both lists collapsing to an empty set and passing vacuously.
    expect(help).toContain("demo-api-key");
    expect(help).toContain("custom-api-key");
    expect(help).toContain("skip");
  });

  it("advertises the generic token-provider choices the dispatcher accepts", async () => {
    const help = await readHelpAuthChoices();

    // `--auth-choice token --token-provider anthropic` is a working, documented
    // combination; help must not hide it behind provider-specific choice ids.
    expect(help).toEqual(expect.arrayContaining(["setup-token", "token", "apiKey"]));
  });

  it("keeps deprecated aliases out of help and out of the accepted set", async () => {
    const help = await readHelpAuthChoices();
    const accepted = await readAcceptedAuthChoices("definitely-not-an-auth-choice");

    expect(help).not.toContain(DEPRECATED_ALIAS);
    expect(accepted).not.toContain(DEPRECATED_ALIAS);
  });
});
