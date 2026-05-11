import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMESSAGE_ATTACHMENT_ROOTS,
  resolveIMessageAttachmentRoots,
  resolveIMessageRemoteAttachmentRoots,
} from "../contract-api.js";

describe("iMessage channel-inbound-roots contract", () => {
  function expectResolvedRootsCase(resolve: () => string[], expected: readonly string[]) {
    expect(resolve()).toEqual(expected);
  }

  const accountOverrideCfg = {
    channels: {
      imessage: {
        attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
        remoteAttachmentRoots: ["/Volumes/shared/imessage"],
        accounts: {
          work: {
            attachmentRoots: ["/Users/work/Library/Messages/Attachments"],
            remoteAttachmentRoots: ["/srv/work/attachments"],
          },
        },
      },
    },
  } as OpenClawConfig;

  it("resolves configured attachment roots with account overrides", () => {
    expectResolvedRootsCase(
      () => resolveIMessageAttachmentRoots({ cfg: accountOverrideCfg, accountId: "work" }),
      ["/Users/work/Library/Messages/Attachments", "/Users/*/Library/Messages/Attachments"],
    );
  });

  it("resolves configured remote attachment roots with account overrides", () => {
    expectResolvedRootsCase(
      () => resolveIMessageRemoteAttachmentRoots({ cfg: accountOverrideCfg, accountId: "work" }),
      [
        "/srv/work/attachments",
        "/Volumes/shared/imessage",
        "/Users/work/Library/Messages/Attachments",
        "/Users/*/Library/Messages/Attachments",
      ],
    );
  });

  it("matches iMessage account ids case-insensitively for attachment roots", () => {
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            Work: {
              attachmentRoots: ["/Users/work/Library/Messages/Attachments"],
            },
          },
        },
      },
    } as OpenClawConfig;

    expectResolvedRootsCase(
      () => resolveIMessageAttachmentRoots({ cfg, accountId: "work" }),
      ["/Users/work/Library/Messages/Attachments", ...DEFAULT_IMESSAGE_ATTACHMENT_ROOTS],
    );
  });

  it("falls back to default iMessage attachment roots", () => {
    expectResolvedRootsCase(
      () => resolveIMessageAttachmentRoots({ cfg: {} as OpenClawConfig }),
      [...DEFAULT_IMESSAGE_ATTACHMENT_ROOTS],
    );
  });

  it("falls back to default iMessage remote attachment roots", () => {
    expectResolvedRootsCase(
      () => resolveIMessageRemoteAttachmentRoots({ cfg: {} as OpenClawConfig }),
      [...DEFAULT_IMESSAGE_ATTACHMENT_ROOTS],
    );
  });
});
