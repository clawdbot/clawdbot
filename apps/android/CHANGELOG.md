# OpenClaw Android Changelog

## Unreleased

Routes exec approval review through the Gateway's durable approval records, including first-answer-wins results from other authorized surfaces, fail-closed reconciliation after ambiguous writes, and compatibility with older Gateway v4 peers.
Shows the localized app version, Git commit, and build date together on the About screen, with real provenance in repository-backed debug builds.

Recovers Android permission prompts after timeouts or cancellation without exhausting future requests. Thanks @NianJiuZst.

Requires a clear in-app disclosure and fresh consent before Installed Apps can share app names, package IDs, and status with a paired Gateway; existing opt-ins must consent again. Thanks @joshavant.

Adds an Android system share target that stages bounded text and image shares for review without losing existing composer drafts. Thanks @NianJiuZst.

Displays configured agent avatars across Android overview, settings, and chat, with bounded data and public remote image loading. Thanks @guarismo.

Shows source-configured provider model inventory, capabilities, and route-aware availability in Android without exposing runtime route details. Thanks @snowzlmbot.

## 2026.7.1 - 2026-07-08

Adds multi-gateway switching with isolated credentials, history, queues, and notification routing.

Upgrades chat with offline recovery, session search and groups, model and agent pickers, voice notes, actions, link previews, code and math rendering.

Adds workspace files, Cron details, terminal access, and Listen playback.

Improves onboarding, reconnects, keyboards, notification filtering, location, canvas safety, and voice reliability.

Thanks @IWhatsskill, @ioridev, and @narcissus0702.

## 2026.6.11 - 2026-07-01

Improves Android gateway setup with localized onboarding, QR pairing fixes, and support for local mDNS gateway hosts.

Adds clearer recovery guidance for TLS fingerprint timeouts, mobile protocol mismatches, and gateway auth states.

Refreshes native Android localization coverage, including Swedish app naming and localized gateway trust flows.

## 2026.6.2 - 2026-06-02

OpenClaw is now available on Android.

Connect to your OpenClaw Gateway to chat with your assistant, use realtime Talk mode, review approvals, and bring Android device capabilities like camera, location, screen, and notifications into your private automation workflows.
