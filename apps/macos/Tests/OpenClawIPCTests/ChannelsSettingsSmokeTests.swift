import OpenClawProtocol
import SwiftUI
import Testing
@testable import OpenClaw

private typealias SnapshotAnyCodable = OpenClaw.AnyCodable

private let channelOrder = ["whatsapp", "telegram", "signal", "imessage"]
private let channelLabels = [
    "whatsapp": "WhatsApp",
    "telegram": "Telegram",
    "signal": "Signal",
    "imessage": "iMessage",
]
private let channelDefaultAccountId = [
    "whatsapp": "default",
    "telegram": "default",
    "signal": "default",
    "imessage": "default",
]

@MainActor
private func makeChannelsStore(
    channels: [String: SnapshotAnyCodable],
    ts: Double = 1_700_000_000_000) -> ChannelsStore
{
    let store = ChannelsStore(isPreview: true)
    store.snapshot = ChannelsStatusSnapshot(
        ts: ts,
        channelOrder: channelOrder,
        channelLabels: channelLabels,
        channelDetailLabels: nil,
        channelSystemImages: nil,
        channelMeta: nil,
        channels: channels,
        channelAccounts: [:],
        channelDefaultAccountId: channelDefaultAccountId)
    return store
}

@Suite(.serialized)
@MainActor
struct ChannelsSettingsSmokeTests {
    @Test func `channels settings builds body with snapshot`() {
        let store = makeChannelsStore(
            channels: [
                "whatsapp": SnapshotAnyCodable([
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
                "telegram": SnapshotAnyCodable([
                    "configured": true,
                    "tokenSource": "env",
                    "running": true,
                    "mode": "polling",
                    "lastStartAt": 1_700_000_000_000,
                    "probe": [
                        "ok": true,
                        "status": 200,
                        "elapsedMs": 120,
                        "bot": ["id": 123, "username": "openclawbot"],
                        "webhook": ["url": "https://example.com/hook", "hasCustomCert": false],
                    ],
                    "lastProbeAt": 1_700_000_050_000,
                ]),
                "signal": SnapshotAnyCodable([
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
                "imessage": SnapshotAnyCodable([
                    "configured": false,
                    "running": false,
                    "lastError": "not configured",
                    "probe": ["ok": false, "error": "imsg not found (imsg)"],
                    "lastProbeAt": 1_700_000_050_000,
                ]),
            ])

        store.whatsappLoginMessage = "Scan QR"
        store.whatsappLoginQrDataUrl =
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ay7pS8AAAAASUVORK5CYII="

        let view = ChannelsSettings(store: store)
        _ = view.body
    }

    @Test func `channels settings builds body without snapshot`() {
        let store = makeChannelsStore(
            channels: [
                "whatsapp": SnapshotAnyCodable([
                    "configured": false,
                    "linked": false,
                    "running": false,
                    "connected": false,
                    "reconnectAttempts": 0,
                ]),
                "telegram": SnapshotAnyCodable([
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
                "signal": SnapshotAnyCodable([
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
                "imessage": SnapshotAnyCodable([
                    "configured": false,
                    "running": false,
                    "lastError": "not configured",
                    "cliPath": "imsg",
                    "probe": ["ok": false, "error": "imsg not found (imsg)"],
                    "lastProbeAt": 1_700_000_200_000,
                ]),
            ])

        let view = ChannelsSettings(store: store)
        _ = view.body
    }

    @Test func `whatsapp login wait result keeps latest qr until connected`() {
        let store = makeChannelsStore(channels: [:])
        store.whatsappLoginQrDataUrl = "data:image/png;base64,initial"

        store.applyWhatsAppLoginWaitResult(
            WhatsAppLoginWaitResult(
                connected: false,
                message: "QR refreshed. Scan the latest code in WhatsApp → Linked Devices.",
                qrDataUrl: "data:image/png;base64,rotated"))

        #expect(store.whatsappLoginQrDataUrl == "data:image/png;base64,rotated")
        #expect(store.whatsappLoginConnected == false)

        store.applyWhatsAppLoginWaitResult(
            WhatsAppLoginWaitResult(
                connected: false,
                message: "Still waiting for the QR scan. Let me know when you’ve scanned it.",
                qrDataUrl: nil))

        #expect(store.whatsappLoginQrDataUrl == "data:image/png;base64,rotated")

        store.applyWhatsAppLoginWaitResult(
            WhatsAppLoginWaitResult(
                connected: true,
                message: "✅ Linked! WhatsApp is ready.",
                qrDataUrl: nil))

        #expect(store.whatsappLoginQrDataUrl == nil)
        #expect(store.whatsappLoginConnected == true)
    }

    @Test func `whatsapp login wait budget allows one final poll`() {
        let startedAt = Date(timeIntervalSince1970: 1_700_000_000)
        var didRunFinalWait = false

        #expect(
            whatsappLoginWaitRequestTimeoutMs(
                startedAt: startedAt,
                timeoutMs: 1000,
                didRunFinalWait: &didRunFinalWait,
                now: Date(timeInterval: 0.25, since: startedAt)) == 750)
        #expect(didRunFinalWait == false)

        #expect(
            whatsappLoginWaitRequestTimeoutMs(
                startedAt: startedAt,
                timeoutMs: 1000,
                didRunFinalWait: &didRunFinalWait,
                now: Date(timeInterval: 1.25, since: startedAt)) == 1)
        #expect(didRunFinalWait == true)

        #expect(
            whatsappLoginWaitRequestTimeoutMs(
                startedAt: startedAt,
                timeoutMs: 1000,
                didRunFinalWait: &didRunFinalWait,
                now: Date(timeInterval: 1.5, since: startedAt)) == nil)
    }
}
