// Whatsapp tests cover groupIngestFrom ingest-only admission behavior.
import { beforeAll, describe, expect, it } from "vitest";
import {
  getAccessControlTestConfig,
  sendMessageMock,
  setAccessControlTestConfig,
  setupAccessControlTestHarness,
  upsertPairingRequestMock,
} from "./access-control.test-harness.js";

setupAccessControlTestHarness();
let checkInboundAccessControl: typeof import("./access-control.js").checkInboundAccessControl;
let isWhatsAppIngestOnlyAdmission: typeof import("./admission.js").isWhatsAppIngestOnlyAdmission;

beforeAll(async () => {
  ({ checkInboundAccessControl } = await import("./access-control.js"));
  ({ isWhatsAppIngestOnlyAdmission } = await import("./admission.js"));
});

const GROUP_JID = "120363401234567890@g.us";
const CREW = "+15550001111";
const STRANGER = "+15550002222";

async function checkGroupSender(senderE164: string, whatsapp: Record<string, unknown>) {
  setAccessControlTestConfig({ channels: { whatsapp } });
  const result = await checkInboundAccessControl({
    cfg: getAccessControlTestConfig() as never,
    accountId: "default",
    from: GROUP_JID,
    selfE164: "+15550009999",
    senderE164,
    group: true,
    pushName: "Sam",
    isFromMe: false,
    sock: { sendMessage: sendMessageMock },
    remoteJid: GROUP_JID,
  });
  expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  expect(sendMessageMock).not.toHaveBeenCalled();
  return result;
}

describe("WhatsApp groupIngestFrom", () => {
  it("admits non-allowlisted senders as ingest-only while allowlisted senders dispatch", async () => {
    const whatsapp = {
      groupPolicy: "allowlist",
      groupAllowFrom: [CREW],
      groupIngestFrom: ["*"],
    };

    const stranger = await checkGroupSender(STRANGER, whatsapp);
    expect(stranger.allowed).toBe(true);
    if (!stranger.allowed) {
      throw new Error("expected ingest-only admission");
    }
    expect(stranger.admission.ingress.admission).toBe("skip");
    expect(stranger.admission.senderAccess.allowed).toBe(false);
    expect(stranger.admission.senderAccess.reasonCode).toBe("group_policy_not_allowlisted");
    expect(isWhatsAppIngestOnlyAdmission(stranger.admission)).toBe(true);

    const crew = await checkGroupSender(CREW, whatsapp);
    expect(crew.allowed).toBe(true);
    if (!crew.allowed) {
      throw new Error("expected dispatch admission");
    }
    expect(crew.admission.ingress.admission).toBe("dispatch");
    expect(isWhatsAppIngestOnlyAdmission(crew.admission)).toBe(false);
  });

  it("lets a per-group ingestFrom admit a sender without a channel default", async () => {
    const result = await checkGroupSender(STRANGER, {
      groupPolicy: "allowlist",
      groupAllowFrom: [CREW],
      groups: { [GROUP_JID]: { ingestFrom: [STRANGER] } },
    });

    expect(result.allowed).toBe(true);
    if (!result.allowed) {
      throw new Error("expected ingest-only admission");
    }
    expect(result.admission.ingress.admission).toBe("skip");
  });

  it.each([
    {
      name: "keeps blocking when groupIngestFrom is unset",
      whatsapp: { groupPolicy: "allowlist", groupAllowFrom: [CREW] },
    },
    {
      name: "never ingests when groupPolicy is disabled",
      whatsapp: { groupPolicy: "disabled", groupIngestFrom: ["*"] },
    },
    {
      name: "lets an empty per-group ingestFrom override the channel wildcard",
      whatsapp: {
        groupPolicy: "allowlist",
        groupAllowFrom: [CREW],
        groupIngestFrom: ["*"],
        groups: { [GROUP_JID]: { ingestFrom: [] } },
      },
    },
    {
      name: "ignores per-group entries that do not match the sender",
      whatsapp: {
        groupPolicy: "allowlist",
        groupAllowFrom: [CREW],
        groups: { [GROUP_JID]: { ingestFrom: ["+15550003333"] } },
      },
    },
  ])("$name", async ({ whatsapp }) => {
    const result = await checkGroupSender(STRANGER, whatsapp);
    expect(result.allowed).toBe(false);
  });
});
