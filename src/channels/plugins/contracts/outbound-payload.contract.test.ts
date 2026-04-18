import { describe } from "vitest";
import {
  installDirectTextMediaOutboundPayloadContractSuite,
  installDiscordOutboundPayloadContractSuite,
  installSlackOutboundPayloadContractSuite,
  installWhatsAppOutboundPayloadContractSuite,
  installZaloOutboundPayloadContractSuite,
  installZalouserOutboundPayloadContractSuite,
} from "../../../../test/helpers/channels/outbound-payload-contract.js";

describe("outbound payload contracts", () => {
  describe("discord", () => {
    installDiscordOutboundPayloadContractSuite();
  });

  describe("imessage", () => {
    installDirectTextMediaOutboundPayloadContractSuite();
  });

  describe("slack", () => {
    installSlackOutboundPayloadContractSuite();
  });

  describe("whatsapp", () => {
    installWhatsAppOutboundPayloadContractSuite();
  });

  describe("zalo", () => {
    installZaloOutboundPayloadContractSuite();
  });

  describe("zalouser", () => {
    installZalouserOutboundPayloadContractSuite();
  });
});
