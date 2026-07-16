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
} from "./whatsapp-live.contracts.js";
import { getWhatsAppQaScenarioDefinition } from "./whatsapp-live.scenarios.js";
import { waitForWhatsAppChannelStable } from "./whatsapp-live.setup.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;
type FlowPreparationInput = Parameters<NonNullable<AdapterDefinition["prepareFlow"]>>[0];

export type WhatsAppQaScenarioEnvironment = {
  driverAuthDir: string;
  gateway: FlowPreparationInput["gateway"];
  getDriver: () => WhatsAppQaDriverSession;
  observedMessages: WhatsAppObservedMessage[];
  replaceDriver: (driver: WhatsAppQaDriverSession) => Promise<void>;
  runtimeEnv: WhatsAppQaRuntimeEnv;
  sutAccountId: string;
  sutAuthDir: string;
};

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
    const scenarioId = input.config.whatsappScenarioId;
    if (typeof scenarioId !== "string") {
      throw new Error("WhatsApp QA module flow requires config.whatsappScenarioId");
    }
    const scenario = getWhatsAppQaScenarioDefinition(scenarioId);
    if (scenario.requiresGroupJid && !params.runtimeEnv.groupJid) {
      if (params.explicitScenarioSelection) {
        throw new Error(
          `Requested WhatsApp scenario ${scenario.id} requires groupJid in the credential payload`,
        );
      }
      throw new QaSuiteScenarioSkipError(
        `WhatsApp scenario ${scenario.id} requires groupJid in the credential payload`,
      );
    }
    const scenarioRun = scenario.buildRun();
    const resolvedTarget = resolveWhatsAppQaScenarioTarget({
      groupJid: params.runtimeEnv.groupJid,
      scenarioId: scenario.id,
      target: scenarioRun.kind === "approval" ? (scenarioRun.target ?? "dm") : scenarioRun.target,
    });
    const groupJid = resolvedTarget.target === "group" ? resolvedTarget.groupJid : undefined;
    const allowFrom =
      scenarioRun.kind === "approval"
        ? [params.runtimeEnv.driverPhoneE164]
        : scenarioRun.configMode === "open"
          ? ["*"]
          : scenarioRun.configMode === "pairing"
            ? ["+15550000000"]
            : [params.runtimeEnv.driverPhoneE164];
    const dmPolicy =
      scenarioRun.kind === "approval"
        ? "allowlist"
        : scenarioRun.configMode === "open" || scenarioRun.configMode === "disabled"
          ? scenarioRun.configMode
          : scenarioRun.configMode === "allowlist"
            ? "allowlist"
            : "pairing";
    const snapshot = await readLiveQaGatewayConfig(input.gateway);
    const cfg = buildWhatsAppQaConfig(snapshot.config as OpenClawConfig, {
      allowFrom,
      authDir: params.sutAuthDir,
      dmPolicy,
      groupJid,
      overrides: scenario.configOverrides,
      sutAccountId: params.accountId,
    });
    await patchLiveQaGatewayConfig({
      gateway: input.gateway,
      patch: cfg as Record<string, unknown>,
      replacePaths: [
        "agents",
        "approvals",
        "broadcast",
        "channels.whatsapp",
        "messages",
        "plugins",
        "tools",
      ],
      timeoutMs: input.timeoutMs,
      waitForConfigRestartSettle: input.waitForConfigRestartSettle,
    });
    await waitForWhatsAppChannelStable(input.gateway as never, params.accountId);
    return {
      whatsappScenarioContext: {
        driverAuthDir: params.driverAuthDir,
        gateway: input.gateway,
        getDriver: params.getDriver,
        observedMessages,
        replaceDriver: params.replaceDriver,
        runtimeEnv: params.runtimeEnv,
        sutAccountId: params.accountId,
        sutAuthDir: params.sutAuthDir,
      } satisfies WhatsAppQaScenarioEnvironment,
    };
  };

  return { prepareFlow };
}
