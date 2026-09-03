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

    @Test func `an edit during a save keeps the save from reloading over it`() {
        // Save admits draft A, the form stays live, and an edit to B lands before the write
        // returns. The completion must not force a reload, which would republish A over B and
        // clear dirty as if B had been persisted.
        let store = makeChannelsStore(channels: [:])
        store.configSourceKey = "source-a"
        store.configLoaded = true
        store.configDraft = ["channels": ["discord": ["enabled": false]]]
        store.configDirty = false

        let admitted = store.configDraftRevision
        store.updateConfigValue(
            path: [.key("channels"), .key("discord"), .key("enabled")],
            value: true)

        #expect(store.configDirty == true)
        #expect(store.configDraftRevision != admitted)
        #expect(ChannelsStore.saveMayReplaceDraft(
            submittedRevision: admitted,
            currentRevision: store.configDraftRevision) == false)

        // That false is what loadConfig receives, and a non forced snapshot leaves the newer
        // edit and the dirty flag alone.
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
    }

    @Test func `a real save that is raced by an edit does not reload over it`() async {
        // Crosses saveConfigDraft and ConfigStore.save rather than poking the pieces, so a
        // later miswiring of the completion is caught. The write is held open, an edit lands
        // while it is in flight, and then it is released. The reload still runs, so gateway
        // normalization is not lost, but it must not replace the newer edit.
        let store = makeChannelsStore(channels: [:])
        // Left nil so the first cache check adopts the real source key instead of treating a
        // made up one as a source change, which would reset the draft before the save runs.
        store.configSourceKey = nil
        store.configLoaded = true
        store.configDraft = ["channels": ["discord": ["enabled": false]]]
        store.configDirty = true
        store.configStatus = nil

        let gate = SaveGate()
        await ConfigStore._testSetOverrides(.init(
            isRemoteMode: { true },
            saveRemote: { _ in await gate.wait() }))

        let saving = Task { await store.saveConfigDraft() }
        await gate.waitUntilEntered()

        store.updateConfigValue(
            path: [.key("channels"), .key("discord"), .key("enabled")],
            value: true)

        await gate.release()
        await saving.value
        await ConfigStore._testClearOverrides()

        let channels = store.configDraft["channels"] as? [String: Any]
        let discord = channels?["discord"] as? [String: Any]
        #expect(discord?["enabled"] as? Bool == true)
        #expect(store.configDirty == true)
    }

    @Test func `a raced save survives a config get that succeeds`() async {
        // The test above holds the write open but leaves the reload to reach a real Gateway,
        // which is not there, so it lands in the catch and would pass even with the guard
        // gone. This one answers config.get with the values the save sent, which is the case
        // the defect needs: the apply runs for real and has to leave the newer edit alone.
        let store = makeChannelsStore(channels: [:])
        store.configSourceKey = nil
        store.configLoaded = true
        store.configDraft = ["channels": ["discord": ["enabled": false]]]
        store.configDirty = true
        store.configStatus = nil

        // What the gateway would hand back after storing the draft as it was submitted.
        let saved = ConfigSnapshot(
            path: nil,
            exists: true,
            raw: nil,
            hash: nil,
            parsed: nil,
            valid: true,
            config: ["channels": SnapshotAnyCodable(["discord": ["enabled": false]])],
            issues: nil)

        let gate = SaveGate()
        await ConfigStore._testSetOverrides(.init(
            isRemoteMode: { true },
            saveRemote: { _ in await gate.wait() },
            fetchConfigSnapshot: { saved }))

        let saving = Task { await store.saveConfigDraft() }
        await gate.waitUntilEntered()

        store.updateConfigValue(
            path: [.key("channels"), .key("discord"), .key("enabled")],
            value: true)

        await gate.release()
        await saving.value
        await ConfigStore._testClearOverrides()

        // The fetch succeeded, so the apply really ran. Without the revision condition it
        // would have forced and put enabled back to false with dirty cleared.
        #expect(store.configStatus == nil)
        let channels = store.configDraft["channels"] as? [String: Any]
        let discord = channels?["discord"] as? [String: Any]
        #expect(discord?["enabled"] as? Bool == true)
        #expect(store.configDirty == true)
    }

    @Test func `a reload queued behind a running one keeps its draft condition`() {
        // A save issued while a refresh is already running does not reload immediately, it is
        // queued. The condition it was issued with has to be queued too, or the replay forces
        // unconditionally and erases the newer draft anyway.
        let store = makeChannelsStore(channels: [:])
        store.configLoading = true
        store.configLoadingSourceKey = "source-a"

        let admitted = store.configDraftRevision
        let queued = store.queueConfigReloadIfLoading(
            sourceKey: "source-a",
            force: true,
            forceUnlessDraftChangedFrom: admitted)

        #expect(queued == true)
        #expect(store.configReloadPending == .force)
        #expect(store.configReloadPendingDraftGuard == admitted)
    }

    @Test func `an unconditional queued reload clears the condition`() {
        // A reload the user asked for should replace the draft, so it must not inherit a
        // condition left behind by a save.
        let store = makeChannelsStore(channels: [:])
        store.configLoading = true
        store.configLoadingSourceKey = "source-a"
        store.configReloadPendingDraftGuard = 7

        _ = store.queueConfigReloadIfLoading(sourceKey: "source-a", force: true)

        #expect(store.configReloadPending == .force)
        #expect(store.configReloadPendingDraftGuard == nil)
    }

    @Test func `a save with no edit behind it still reloads and clears dirty`() async {
        // The other half of the guard. Nothing is typed during this save, so the reload has
        // to force exactly as it always did and the gateway's own view has to land. Asserting
        // only that the revision comparison says true would still pass if the save stopped
        // reloading altogether, which is the case this is here to catch.
        let store = makeChannelsStore(channels: [:])
        store.configSourceKey = nil
        store.configLoaded = true
        store.configDraft = ["channels": ["discord": ["enabled": true]]]
        store.configDirty = true
        store.configStatus = nil

        // Stands in for normalization: what comes back is not what went out.
        let normalized = ConfigSnapshot(
            path: nil,
            exists: true,
            raw: nil,
            hash: nil,
            parsed: nil,
            valid: true,
            config: ["channels": SnapshotAnyCodable(["discord": ["enabled": false]])],
            issues: nil)

        await ConfigStore._testSetOverrides(.init(
            isRemoteMode: { true },
            saveRemote: { _ in },
            fetchConfigSnapshot: { normalized }))

        await store.saveConfigDraft()
        await ConfigStore._testClearOverrides()

        #expect(store.configStatus == nil)
        let channels = store.configDraft["channels"] as? [String: Any]
        let discord = channels?["discord"] as? [String: Any]
        #expect(discord?["enabled"] as? Bool == false)
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

/// Holds a save open so an edit can land while it is in flight.
private actor SaveGate {
    private var entered = false
    private var released = false
    private var enteredWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        self.entered = true
        for waiter in self.enteredWaiters {
            waiter.resume()
        }
        self.enteredWaiters.removeAll()
        if self.released { return }
        await withCheckedContinuation { self.releaseWaiters.append($0) }
    }

    func waitUntilEntered() async {
        if self.entered { return }
        await withCheckedContinuation { self.enteredWaiters.append($0) }
    }

    func release() {
        self.released = true
        for waiter in self.releaseWaiters {
            waiter.resume()
        }
        self.releaseWaiters.removeAll()
    }
}
