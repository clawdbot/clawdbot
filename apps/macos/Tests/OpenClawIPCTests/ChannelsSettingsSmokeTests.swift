import Foundation
import OpenClawProtocol
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

@MainActor
private func makeChannelsSettings(snapshot: String) throws -> ChannelsSettings {
    let store = ChannelsStore(isPreview: true)
    store.snapshot = try JSONDecoder().decode(
        ChannelsStatusSnapshot.self,
        from: Data(snapshot.utf8))
    return ChannelsSettings(store: store)
}

@Suite(.serialized)
@MainActor
struct ChannelsSettingsSmokeTests {
    @Test func `generic channel account errors replace misleading active status`() throws {
        let settings = try makeChannelsSettings(snapshot: """
        {
          "ts": 1,
          "channelOrder": ["matrix", "mattermost", "disabled"],
          "channelLabels": {"matrix": "Matrix", "mattermost": "Mattermost", "disabled": "Disabled"},
          "channels": {
            "matrix": {"configured": true},
            "mattermost": {"configured": true, "lastError": "Channel summary failed"},
            "disabled": {"configured": false}
          },
          "channelAccounts": {
            "matrix": [
              {"accountId": "healthy", "configured": true},
              {"accountId": "failed", "configured": true, "lastError": "First account probe failed"},
              {"accountId": "later", "configured": true, "lastError": "Later account failed"}
            ],
            "mattermost": [
              {"accountId": "default", "configured": true, "lastError": "Account failure"}
            ],
            "disabled": []
          },
          "channelDefaultAccountId": {
            "matrix": "healthy",
            "mattermost": "default",
            "disabled": "default"
          }
        }
        """)
        let channels = Dictionary(uniqueKeysWithValues: settings.orderedChannels.map { ($0.id, $0) })
        let matrix = try #require(channels["matrix"])
        let mattermost = try #require(channels["mattermost"])
        let disabled = try #require(channels["disabled"])

        #expect(settings.channelEnabled(matrix))
        #expect(settings.channelHasError(matrix))
        #expect(settings.channelSummary(matrix) == "Error")
        #expect(settings.channelDetails(matrix) == "Error: First account probe failed")

        #expect(settings.channelHasError(mattermost))
        #expect(settings.channelDetails(mattermost) == "Error: Channel summary failed")

        #expect(!settings.channelEnabled(disabled))
        #expect(!settings.channelHasError(disabled))
        #expect(settings.channelSummary(disabled) == "Not configured")
        #expect(settings.channelDetails(disabled) == nil)
    }

    @Test func `failed channel probes remain visible across generic and bundled channels`() throws {
        let settings = try makeChannelsSettings(snapshot: """
        {
          "ts": 1,
          "channelOrder": ["matrix", "telegram"],
          "channelLabels": {"matrix": "Matrix", "telegram": "Telegram"},
          "channels": {
            "matrix": {"configured": true, "probe": {"ok": false}},
            "telegram": {"configured": true, "running": true, "probe": {"ok": false}}
          },
          "channelAccounts": {"matrix": [], "telegram": []},
          "channelDefaultAccountId": {"matrix": "default", "telegram": "default"}
        }
        """)

        for channel in settings.orderedChannels {
            #expect(settings.channelHasError(channel), "\(channel.id) should surface its failed probe")
        }
    }

    @Test func `whatsapp logout remains a channel error without a message`() throws {
        let settings = try makeChannelsSettings(snapshot: """
        {
          "ts": 1,
          "channelOrder": ["whatsapp"],
          "channelLabels": {"whatsapp": "WhatsApp"},
          "channels": {
            "whatsapp": {
              "configured": true,
              "linked": true,
              "running": false,
              "connected": false,
              "reconnectAttempts": 0,
              "lastDisconnect": {"at": 1, "loggedOut": true}
            }
          },
          "channelAccounts": {"whatsapp": []},
          "channelDefaultAccountId": {"whatsapp": "default"}
        }
        """)
        let channel = try #require(settings.orderedChannels.first)

        #expect(settings.channelHasError(channel))
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

    @Test func `cached config loads return without clearing dirty draft`() {
        let store = makeChannelsStore(channels: [:])
        store.configSchema = ConfigSchemaNode(raw: ["type": "object"])
        store.configSchemaSourceKey = "source-a"
        store.configLoaded = true
        store.configSourceKey = "source-a"
        store.configDraft = ["channels": ["discord": ["enabled": true]]]
        store.configDirty = true

        store.resetConfigSchemaCacheIfSourceChanged("source-a")
        store.resetConfigCacheIfSourceChanged("source-a")

        #expect(store.configSchema != nil)
        #expect(store.configDraft["channels"] != nil)
        #expect(store.configDirty == true)
    }

    @Test func `config cache clears dirty draft when source changes`() {
        let store = makeChannelsStore(channels: [:])
        store.configSchema = ConfigSchemaNode(raw: ["type": "object"])
        store.configSchemaSourceKey = "source-a"
        store.configUiHints = ["channels.discord.enabled": ConfigUiHint(raw: ["label": "Discord"])]
        store.configLoaded = true
        store.configSourceKey = "source-a"
        store.configRoot = ["channels": ["discord": ["enabled": false]]]
        store.configDraft = ["channels": ["discord": ["enabled": true]]]
        store.configDirty = true

        store.resetConfigSchemaCacheIfSourceChanged("source-b")
        store.resetConfigCacheIfSourceChanged("source-b")

        #expect(store.configSchema == nil)
        #expect(store.configUiHints.isEmpty)
        #expect(store.configLoaded == false)
        #expect(store.configRoot.isEmpty)
        #expect(store.configDraft.isEmpty)
        #expect(store.configDirty == false)
        #expect(store.configSchemaSourceKey == "source-b")
        #expect(store.configSourceKey == "source-b")
    }

    @Test func `schema response is ignored after source changes`() {
        let store = makeChannelsStore(channels: [:])
        store.configSchemaSourceKey = "source-b"
        let res = ConfigSchemaResponse(
            schema: SnapshotAnyCodable(["type": "object", "properties": ["stale": ["type": "string"]]]),
            uihints: ["stale": SnapshotAnyCodable(["label": "Stale"])],
            version: "1",
            generatedat: "now")

        store.applyConfigSchemaResponse(res, sourceKey: "source-a")

        #expect(store.configSchema == nil)
        #expect(store.configUiHints.isEmpty)
        #expect(store.configSchemaSourceKey == "source-b")
    }

    @Test func `non forced config snapshots do not overwrite dirty draft`() {
        let store = makeChannelsStore(channels: [:])
        store.configSourceKey = "source-a"
        store.configLoaded = true
        store.configDraft = ["channels": ["discord": ["enabled": true]]]
        store.configDirty = true
        let snap = ConfigSnapshot(
            path: nil,
            exists: true,
            raw: nil,
            hash: nil,
            parsed: nil,
            valid: true,
            config: ["channels": SnapshotAnyCodable(["discord": ["enabled": false]])],
            issues: nil)

        store.applyConfigSnapshot(snap, sourceKey: "source-a", force: false)

        let channels = store.configDraft["channels"] as? [String: Any]
        let discord = channels?["discord"] as? [String: Any]
        #expect(discord?["enabled"] as? Bool == true)
        #expect(store.configDirty == true)

        store.applyConfigSnapshot(snap, sourceKey: "source-a", force: true)

        let forcedChannels = store.configDraft["channels"] as? [String: Any]
        let forcedDiscord = forcedChannels?["discord"] as? [String: Any]
        #expect(forcedDiscord?["enabled"] as? Bool == false)
        #expect(store.configDirty == false)
    }

    @Test func `forced config load queues behind background load`() {
        let store = makeChannelsStore(channels: [:])
        store.configLoading = true
        store.configLoadingSourceKey = "source-a"

        #expect(store.queueConfigReloadIfLoading(sourceKey: "source-a", force: false) == true)
        #expect(store.configReloadPending == .none)

        #expect(store.queueConfigReloadIfLoading(sourceKey: "source-a", force: false, refresh: true) == true)
        #expect(store.configReloadPending == .refresh)

        #expect(store.queueConfigReloadIfLoading(sourceKey: "source-a", force: true) == true)
        #expect(store.configReloadPending == .force)

        // Force is sticky: a queued refresh must not downgrade a pending force reload.
        #expect(store.queueConfigReloadIfLoading(sourceKey: "source-a", force: false, refresh: true) == true)
        #expect(store.configReloadPending == .force)

        store.configReloadPending = .none
        #expect(store.queueConfigReloadIfLoading(sourceKey: "source-b", force: false) == true)
        #expect(store.configReloadPending == .force)
    }

    @Test func `schema reload queues behind background load after source changes`() {
        let store = makeChannelsStore(channels: [:])
        store.configSchemaLoading = true
        store.configSchemaLoadingSourceKey = "source-a"

        #expect(store.queueConfigSchemaReloadIfLoading(sourceKey: "source-a", force: false) == true)
        #expect(store.configSchemaReloadPending == false)

        #expect(store.queueConfigSchemaReloadIfLoading(sourceKey: "source-a", force: true) == true)
        #expect(store.configSchemaReloadPending == true)

        store.configSchemaReloadPending = false
        #expect(store.queueConfigSchemaReloadIfLoading(sourceKey: "source-b", force: false) == true)
        #expect(store.configSchemaReloadPending == true)
    }
}
