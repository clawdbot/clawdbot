import { describe } from "vitest";
import { installDiscordInboundContractSuite } from "../../../../test/helpers/channels/inbound-contract.discord.js";
import { installSignalInboundContractSuite } from "../../../../test/helpers/channels/inbound-contract.signal.js";
import { installSlackInboundContractSuite } from "../../../../test/helpers/channels/inbound-contract.slack.js";
import { installTelegramInboundContractSuite } from "../../../../test/helpers/channels/inbound-contract.telegram.js";
import { installWhatsAppInboundContractSuite } from "../../../../test/helpers/channels/inbound-contract.whatsapp.js";

describe("inbound channel contracts", () => {
  describe("discord", () => {
    installDiscordInboundContractSuite();
  });

  describe("signal", () => {
    installSignalInboundContractSuite();
  });

  describe("slack", () => {
    installSlackInboundContractSuite();
  });

  describe("telegram", () => {
    installTelegramInboundContractSuite();
  });

  describe("whatsapp", () => {
    installWhatsAppInboundContractSuite();
  });
});
