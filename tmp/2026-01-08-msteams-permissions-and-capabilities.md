---
date: 2026-01-08
author: Onur <onur@textcortex.com>
title: MS Teams Permissions vs Capabilities (Clawdbot)
tags: [msteams, permissions, graph]
---

## Overview
This doc explains what Clawdbot can and cannot do in Microsoft Teams depending on **Teams resource-specific consent (RSC)** only versus **RSC + Microsoft Graph permissions**. It also outlines the exact steps needed to unlock each capability.

## Current Teams RSC Permissions (Manifest)
These are the **existing resourceSpecific permissions** in the Teams app manifest (already in our ZIP):

- `ChannelMessage.Read.Group` (Application)
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

These only apply **inside the team where the app is installed**.

## Capability Matrix

### With **Teams RSC only** (app installed in a team, no Graph API permissions)
Works:
- Read channel message **text** content.
- Send channel message **text** content.
- Resolve basic sender identity (AAD/user id) and channel/team context.
- Use conversation references for proactive messages **only after** a user interacts.

Does NOT work:
- **Image/file content** from channel or group chat messages (payload only includes HTML stub).
- Downloading attachments stored in SharePoint/OneDrive (requires Graph).
- Accessing messages outside the installed team.

### With **Teams RSC + Microsoft Graph Application permissions**
Adds:
- Downloading **hosted contents** (images pasted into messages).
- Downloading **file attachments** stored in SharePoint/OneDrive.
- Full message/attachment lookup via Graph endpoints.

Still **not** added automatically:
- 1:1 chat file support (requires separate Bot file flows if we want to support it).
- Cross-tenant access (blocked by tenant policies).

## Required Steps by Capability

### Phase 1 — Basic text-only channel bot
Goal: Read/send text messages in installed teams.

Steps:
1. **Teams app manifest** includes the RSC permissions listed above.
2. Admin or user installs the app into a specific team.
3. Bot receives text-only channel message payloads.

Expected behavior:
- Text is visible to the bot.
- Image/file attachments are **not** available (only HTML stub).

### Phase 2 — Image and file ingestion (Graph enabled)
Goal: Download images/files from Teams messages.

Steps:
1. In **Entra ID (Azure AD)** app registration for the bot, add **Microsoft Graph Application permissions**:
   - For channel attachments: `ChannelMessage.Read.All`
   - For chat/group attachments: `Chat.Read.All` (or `ChatMessage.Read.All`)
2. **Grant admin consent** in the tenant.
3. Increment Teams app **manifest version** and re-upload.
4. **Reinstall the app in Teams** (remove + add) and **fully quit/reopen Teams** to clear cached app metadata.

Expected behavior:
- Bot still receives HTML stubs in the webhook.
- Bot now fetches hosted contents and attachments via Graph and can access images.

## Why Graph Is Required for Images
Teams stores images and files in Microsoft 365 storage (SharePoint/OneDrive). The Teams bot webhook **does not send file bytes**, only a message shell. To access the actual file, the app must call **Microsoft Graph** with sufficient permissions.

If Graph tokens are unavailable (permissions missing or no admin consent), image downloads will always fail.

## Validation Checklist
- [ ] Teams app installed in target team.
- [ ] Graph permissions added and admin consented.
- [ ] Teams app version incremented and reinstalled.
- [ ] Logs show successful Graph token acquisition.
- [ ] Logs show Graph hostedContent/attachments fetched (non-zero counts).

## References
- Teams bot file handling (channel/group requires Graph):
  - https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4
