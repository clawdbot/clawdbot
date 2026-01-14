import SwiftUI
import Testing
@testable import Clawdbot

@Suite(.serialized)
@MainActor
    struct ConnectionsSettingsSmokeTests {
        @Test func connectionsSettingsBuildsBodyWithSnapshot() {
            let store = ConnectionsStore(isPreview: true)
            store.snapshot = ChannelsStatusSnapshot(
                ts: 1_700_000_000_000,
                channelOrder: ["whatsapp", "telegram", "signal", "imessage"],
                channelLabels: [
                    "whatsapp": "WhatsApp",
                    "telegram": "Telegram",
                    "signal": "Signal",
                    "imessage": "iMessage",
                ],
                channels: [
                    "whatsapp": AnyCodable([
                        "configured": true,
                        "linked": true,
                    "authAgeMs": 86_400_000,
                    "self": ["e164": "+15551234567"],
                    "running": true,
                    "connected": false,
                    "lastConnectedAt": 1_700_000_000_000,
                    "lastDisconnect": [
                        "at": 1_700_000_050_000,
                        "status": 401,
                        "error": "logged out",
                        "loggedOut": true,
                    ],
                    "reconnectAttempts": 2,
                    "lastMessageAt": 1_700_000_060_000,
                    "lastEventAt": 1_700_000_060_000,
                    "lastError": "needs login",
                ]),
                "telegram": AnyCodable([
                    "configured": true,
                    "tokenSource": "env",
                    "running": true,
                    "mode": "polling",
                    "lastStartAt": 1_700_000_000_000,
                    "probe": [
                        "ok": true,
                        "status": 200,
                        "elapsedMs": 120,
                        "bot": ["id": 123, "username": "clawdbotbot"],
                        "webhook": ["url": "https://example.com/hook", "hasCustomCert": false],
                    ],
                    "lastProbeAt": 1_700_000_050_000,
                ]),
                "signal": AnyCodable([
                    "configured": true,
                    "baseUrl": "http://127.0.0.1:8080",
                    "running": true,
                    "lastStartAt": 1_700_000_000_000,
                    "probe": [
                        "ok": true,
                        "status": 200,
                        "elapsedMs": 140,
                        "version": "0.12.4",
                    ],
                    "lastProbeAt": 1_700_000_050_000,
                ]),
                "imessage": AnyCodable([
                    "configured": false,
                    "running": false,
                    "lastError": "not configured",
                    "probe": ["ok": false, "error": "imsg not found (imsg)"],
                    "lastProbeAt": 1_700_000_050_000,
                    ]),
                ],
                channelAccounts: [:],
                channelDefaultAccountId: [
                    "whatsapp": "default",
                    "telegram": "default",
                    "signal": "default",
                "imessage": "default",
            ])

        store.whatsappLoginMessage = "Scan QR"
        store.whatsappLoginQrDataUrl =
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ay7pS8AAAAASUVORK5CYII="
        store.telegramToken = "123:abc"
        store.telegramRequireMention = false
        store.telegramAllowFrom = "123456789"
        store.telegramProxy = "socks5://localhost:9050"
        store.telegramWebhookUrl = "https://example.com/telegram"
        store.telegramWebhookSecret = "secret"
        store.telegramWebhookPath = "/telegram"

        let view = ConnectionsSettings(store: store)
        _ = view.body
        }

        @Test func connectionsSettingsBuildsBodyWithoutSnapshot() {
            let store = ConnectionsStore(isPreview: true)
            store.snapshot = ChannelsStatusSnapshot(
                ts: 1_700_000_000_000,
                channelOrder: ["whatsapp", "telegram", "signal", "imessage"],
                channelLabels: [
                    "whatsapp": "WhatsApp",
                    "telegram": "Telegram",
                    "signal": "Signal",
                    "imessage": "iMessage",
                ],
                channels: [
                    "whatsapp": AnyCodable([
                        "configured": false,
                        "linked": false,
                    "running": false,
                    "connected": false,
                    "reconnectAttempts": 0,
                ]),
                "telegram": AnyCodable([
                    "configured": false,
                    "running": false,
                    "lastError": "bot missing",
                    "probe": [
                        "ok": false,
                        "status": 403,
                        "error": "unauthorized",
                        "elapsedMs": 120,
                    ],
                    "lastProbeAt": 1_700_000_100_000,
                ]),
                "signal": AnyCodable([
                    "configured": false,
                    "baseUrl": "http://127.0.0.1:8080",
                    "running": false,
                    "lastError": "not configured",
                    "probe": [
                        "ok": false,
                        "status": 404,
                        "error": "unreachable",
                        "elapsedMs": 200,
                    ],
                    "lastProbeAt": 1_700_000_200_000,
                ]),
                "imessage": AnyCodable([
                    "configured": false,
                    "running": false,
                    "lastError": "not configured",
                    "cliPath": "imsg",
                    "probe": ["ok": false, "error": "imsg not found (imsg)"],
                    "lastProbeAt": 1_700_000_200_000,
                    ]),
                ],
                channelAccounts: [:],
                channelDefaultAccountId: [
                    "whatsapp": "default",
                    "telegram": "default",
                    "signal": "default",
                "imessage": "default",
            ])

        let view = ConnectionsSettings(store: store)
        _ = view.body
    }
}
