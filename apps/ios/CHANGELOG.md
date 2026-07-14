# OpenClaw iOS Changelog

## Unreleased

- Allows iPhone nodes and Apple Watch features relayed through a paired iPhone to connect to Gateway protocol v3 or v4, while direct Watch and operator-only Apple clients remain on v4.
- Adds Installed and Browse skill management with readiness filters, enable/disable controls, exact-version ClawHub review, and Gateway-enforced risk acknowledgement. (#105741)
- Routes iPhone and Apple Watch exec approvals through durable Gateway records, preserves safety warnings, shows the first recorded decision across surfaces, reconciles uncertain replies, and remains compatible with shipped Gateway v4 approval RPCs.
- Improves Gateway onboarding diagnostics, permission registration refreshes, Talk session switching, agent overview refresh ordering, and Apple Watch acknowledgment, activation, and cold-start event handling.

## 2026.7.1 - 2026-07-08

- Added multi-gateway pairing and switching with gateway-scoped credentials, TLS trust, cached chats, push registration, and custom proxy headers.
- Added voice-note recording, a slash-command picker, durable offline sending, and read-only offline session and transcript access.
- Added session search, archived browsing, groups, unread state, rename/delete actions, and new-session creation in managed worktrees.
- Improved chat rendering with syntax-highlighted code, native tables, inline and display math, expandable link previews, streaming prose animation, and Markdown export.
- Added model favorites and recents, working model switching, and reasoning controls that adapt to model capabilities.
- Added Listen and Stop controls for assistant messages, using configured Gateway speech with an on-device fallback.
- Added a read-only Files browser for agent workspaces and an authenticated Gateway terminal destination.
- Added Apple Watch voice turns and made pairing, activation, and queued replies more reliable.
- Refreshed the native iOS design with branded typography, denser controls, an animated mascot, and a redesigned About screen.
- Fixed permission prompts, onboarding and QR handoff, reconnect recovery, screen-recording finalization, Voice Wake startup, and contact creation.

## 2026.6.11 - 2026-07-01

Maintenance update for the current OpenClaw release.

- Refreshed iOS 26 visual styling, Talk controls, Gateway recovery, localization, and App Store screenshots.

## 2026.6.10 - 2026-06-21

Maintenance update for the current OpenClaw release.

- Improved notification cleanup, Watch app compatibility, and native file input handling.

## 2026.6.9 - 2026-06-20

Maintenance update for the current OpenClaw release.

- Added Apple Watch controls for common agent actions.
- Improved Gateway setup, notification settings, and share-extension identity handling.
- Updated the Watch app integration for current Xcode compatibility.

## 2026.6.2 - 2026-06-02

OpenClaw is now available on iPhone.

Connect to your OpenClaw Gateway to chat with your assistant, use realtime Talk mode, review approvals, share content from iOS, and bring device capabilities like camera, location, screen, and notifications into your private automation workflows.

## 2026.6.1 - 2026-06-01

Maintenance update for the current OpenClaw release.

- Added hosted push relay defaults, realtime Talk playback, and safer WebSocket ping handling for mobile sessions.
- Updated App Store screenshots to cover Gateway pairing, Command, Chat, Talk, Agent, and Settings flows.
- Highlighted realtime Talk relay, Gateway connection status, node capabilities, push wake, and privacy controls.

## 2026.5.28 - 2026-05-28

Maintenance update for the current OpenClaw release.

## 2026.5.27 - 2026-05-27

Maintenance update for the current OpenClaw release.

## 2026.5.26 - 2026-05-26

Maintenance update for the current OpenClaw release.

## 2026.5.25 - 2026-05-25

Maintenance update for the current OpenClaw release.

## 2026.5.24 - 2026-05-24

Maintenance update for the current OpenClaw release.

## 2026.5.22 - 2026-05-22

Maintenance update for the current OpenClaw release.

## 2026.5.21 - 2026-05-21

Maintenance update for the current OpenClaw release.

- Added realtime Gateway Talk relay support for iOS voice sessions, including OpenAI realtime provider and voice selection controls. Thanks @Solvely-Colin.

## 2026.5.20 - 2026-05-20

Maintenance update for the current OpenClaw release.

## 2026.5.19 - 2026-05-19

Maintenance update for the current OpenClaw release.

## 2026.5.17 - 2026-05-17

Maintenance update for the current OpenClaw release.

## 2026.5.12 - 2026-05-12

Maintenance update for the current OpenClaw release.

## 2026.5.10 - 2026-05-10

Maintenance update for the current OpenClaw release.

- Gateway connections now recover after a trusted Gateway certificate changes by refreshing the stored certificate pin during reconnect.

## 2026.5.8 - 2026-05-08

Maintenance update for the current OpenClaw development release.

## 2026.5.6 - 2026-05-06

Maintenance update for the current OpenClaw development release.

## 2026.5.5 - 2026-05-05

Maintenance update for the current OpenClaw development release.

## 2026.5.4 - 2026-05-04

Maintenance update for the current OpenClaw development release.

- Gateway pairing now supports scanning QR codes from Settings and accepts full copied setup-code messages while keeping non-loopback `ws://` setup links blocked.

## 2026.5.3 - 2026-05-03

Maintenance update for the current OpenClaw development release.

## 2026.5.2 - 2026-05-02

Maintenance update for the current OpenClaw development release.

## 2026.4.30 - 2026-04-30

Maintenance update for the current OpenClaw development release.

## 2026.4.27 - 2026-04-27

Maintenance update for the current OpenClaw development release.

## 2026.4.26 - 2026-04-26

Maintenance update for the current OpenClaw development release.

- Refreshed build hygiene for the iOS app, Share extension, Activity widget, Watch app, and curated shared Swift sources; relay registration now uses StoreKit app transaction JWS data instead of deprecated receipt APIs.

## 2026.4.25 - 2026-04-25

Maintenance update for the current OpenClaw development release.

## 2026.4.23 - 2026-04-23

Maintenance update for the current OpenClaw development release.

## 2026.4.22 - 2026-04-22

Maintenance update for the current OpenClaw development release.

## 2026.4.21 - 2026-04-21

Maintenance update for the current OpenClaw development release.

## 2026.4.20 - 2026-04-20

Maintenance update for the current OpenClaw release.

## 2026.4.19 - 2026-04-19

Maintenance update for the current OpenClaw release.

## 2026.4.18 - 2026-04-18

Maintenance update for the current OpenClaw release.

## 2026.4.15 - 2026-04-15

Maintenance update for the current OpenClaw release.

## 2026.4.14 - 2026-04-14

Maintenance update for the current OpenClaw release.

## 2026.4.12 - 2026-04-12

Maintenance update for the current OpenClaw release.

## 2026.4.10 - 2026-04-10

Maintenance update for the current OpenClaw release.

## 2026.4.6 - 2026-04-06

First App Store release of OpenClaw for iPhone. Pair with your OpenClaw Gateway to use chat, voice, sharing, and device actions from iOS.
