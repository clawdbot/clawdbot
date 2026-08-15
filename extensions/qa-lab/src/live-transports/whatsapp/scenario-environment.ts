import type { WhatsAppQaDriverSession } from "@openclaw/whatsapp/api.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import { QaSuiteScenarioSkipError } from "../../errors.js";
import {
  patchLiveQaGatewayConfig,
  readLiveQaGatewayConfig,
} from "../shared/live-gateway-config.runtime.js";
import { buildWhatsAppQaConfig } from "./whatsapp-live.config.js";
import {
  resolveWhatsAppQaScenarioTarget,
  type WhatsAppObservedMessage,
  type WhatsAppQaRuntimeEnv,
  type WhatsAppQaScenarioImplementation,
  type WhatsAppQaScenarioRun,
} from "./whatsapp-live.contracts.js";
import { waitForWhatsAppChannelStable } from "./whatsapp-live.setup.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;
type FlowPreparationInput = Parameters<NonNullable<AdapterDefinition["prepareFlow"]>>[0];

export type WhatsAppQaScenarioEnvironment = {
  configureScenario: (implementation: WhatsAppQaScenarioImplementation) => Promise<{
    run: WhatsAppQaScenarioRun;
  }>;
  driverAuthDir: string;
  gateway: FlowPreparationInput["gateway"];
  getDriver: () => WhatsAppQaDriverSession;
  observedMessages: WhatsAppObservedMessage[];
  replaceDriver: (driver: WhatsAppQaDriverSession) => Promise<void>;
  runtimeEnv: WhatsAppQaRuntimeEnv;
  scenario: { id: string; timeoutMs: number; title: string };
  sutAccountId: string;
  sutAuthDir: string;
};

function resolveWhatsAppQaReplacePaths(accountId: string): string[] {
  return [
    "agents",
    "approvals",
    "broadcast",
    "channels.whatsapp",
    `channels.whatsapp.accounts.${accountId}.allowFrom`,
    "messages",
    "plugins",
    "tools",
  ];
}

export function createWhatsAppQaScenarioEnvironment(params: {
  accountId: string;
  driverAuthDir: string;
  explicitScenarioSelection: boolean;
  getDriver: () => WhatsAppQaDriverSession;
  replaceDriver: (driver: WhatsAppQaDriverSession) => Promise<void>;
  runtimeEnv: WhatsAppQaRuntimeEnv;
  sutAuthDir: string;
}) {
  const observedMessages: WhatsAppObservedMessage[] = [];

  const prepareFlow = async (input: FlowPreparationInput) => {
    return {
      whatsappScenarioContext: {
        configureScenario: async (implementation: WhatsAppQaScenarioImplementation) => {
          if (implementation.requiresGroupJid && !params.runtimeEnv.groupJid) {
            if (params.explicitScenarioSelection) {
              throw new Error(
                `Requested WhatsApp scenario ${input.scenarioId} requires groupJid in the credential payload`,
              );
            }
            throw new QaSuiteScenarioSkipError(
              `WhatsApp scenario ${input.scenarioId} requires groupJid in the credential payload`,
            );
          }
          const run = implementation.buildRun();
          const resolvedTarget = resolveWhatsAppQaScenarioTarget({
            groupJid: params.runtimeEnv.groupJid,
            scenarioId: input.scenarioId,
            target: run.kind === "approval" ? (run.target ?? "dm") : run.target,
          });
          const groupJid = resolvedTarget.target === "group" ? resolvedTarget.groupJid : undefined;
          const allowFrom =
            run.kind === "approval"
              ? [params.runtimeEnv.driverPhoneE164]
              : run.configMode === "open"
                ? ["*"]
                : run.configMode === "pairing"
                  ? ["+15550000000"]
                  : [params.runtimeEnv.driverPhoneE164];
          const dmPolicy =
            run.kind === "approval"
              ? "allowlist"
              : run.configMode === "open" || run.configMode === "disabled"
                ? run.configMode
                : run.configMode === "allowlist"
                  ? "allowlist"
                  : "pairing";
          const snapshot = await readLiveQaGatewayConfig(input.gateway);
          const cfg = buildWhatsAppQaConfig(snapshot.config as OpenClawConfig, {
            allowFrom,
            authDir: params.sutAuthDir,
            dmPolicy,
            groupJid,
            ownerAllowFrom: [params.runtimeEnv.driverPhoneE164],
            overrides: implementation.configOverrides,
            sutAccountId: params.accountId,
          });
          await patchLiveQaGatewayConfig({
            gateway: input.gateway,
            patch: cfg as Record<string, unknown>,
            replacePaths: resolveWhatsAppQaReplacePaths(params.accountId),
            timeoutMs: input.timeoutMs,
            waitForConfigRestartSettle: input.waitForConfigRestartSettle,
          });
          await waitForWhatsAppChannelStable(input.gateway as never, params.accountId);
          return { run };
        },
        driverAuthDir: params.driverAuthDir,
        gateway: input.gateway,
        getDriver: params.getDriver,
        observedMessages,
        replaceDriver: params.replaceDriver,
        runtimeEnv: params.runtimeEnv,
        scenario: {
          id: input.scenarioId,
          timeoutMs: input.timeoutMs,
          title: input.scenarioTitle,
        },
        sutAccountId: params.accountId,
        sutAuthDir: params.sutAuthDir,
      } satisfies WhatsAppQaScenarioEnvironment,
    };
  };

  return { prepareFlow };
}
