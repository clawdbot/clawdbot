---
summary: "Redirect to /plugins/sdk-channel-outbound"
title: "Channel message API"
---

This page moved to [Channel outbound API](/plugins/sdk-channel-outbound).

`openclaw/plugin-sdk/channel-message` remains a deprecated compatibility
subpath for older plugins. New channel plugins should use
`openclaw/plugin-sdk/channel-outbound` for message lifecycle, receipt,
durable send, and live preview helpers instead of adding new helpers to the
deprecated subpath.

Removal plan: keep these aliases through the external plugin migration
window, then remove them in the next major SDK cleanup after callers have
moved to `channel-outbound`.
