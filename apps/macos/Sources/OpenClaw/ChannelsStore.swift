import Foundation
import Observation
import OpenClawProtocol
import OSLog

struct ChannelsStatusSnapshot: Codable {
    struct WhatsAppSelf: Codable {
        let e164: String?
        let jid: String?
    }

    struct WhatsAppDisconnect: Codable {
        let at: Double
        let status: Int?
        let error: String?
        let loggedOut: Bool?
    }

    struct WhatsAppStatus: Codable {
        let configured: Bool
        let linked: Bool
        let authAgeMs: Double?
        let `self`: WhatsAppSelf?
        let running: Bool
        let connected: Bool
        let lastConnectedAt: Double?
        let lastDisconnect: WhatsAppDisconnect?
        let reconnectAttempts: Int
        let lastMessageAt: Double?
        let lastEventAt: Double?
        let lastError: String?
    }

    struct TelegramBot: Codable {
        let id: Int?
        let username: String?
    }

    struct TelegramWebhook: Codable {
        let url: String?
        let hasCustomCert: Bool?
    }

    struct TelegramProbe: Codable {
        let ok: Bool
        let status: Int?
        let error: String?
        let elapsedMs: Double?
        let bot: TelegramBot?
        let webhook: TelegramWebhook?
    }

    struct TelegramStatus: Codable {
        let configured: Bool
        let tokenSource: String?
        let running: Bool
        let mode: String?
        let lastStartAt: Double?
        let lastStopAt: Double?
        let lastError: String?
        let probe: TelegramProbe?
        let lastProbeAt: Double?
    }

    struct DiscordBot: Codable {
        let id: String?
        let username: String?
    }

    struct DiscordProbe: Codable {
        let ok: Bool
        let status: Int?
        let error: String?
        let elapsedMs: Double?
        let bot: DiscordBot?
    }

    struct DiscordStatus: Codable {
        let configured: Bool
        let tokenSource: String?
        let running: Bool
        let lastStartAt: Double?
        let lastStopAt: Double?
        let lastError: String?
        let probe: DiscordProbe?
        let lastProbeAt: Double?
    }

    struct GoogleChatProbe: Codable {
        let ok: Bool
        let status: Int?
        let error: String?
        let elapsedMs: Double?
    }

    struct GoogleChatStatus: Codable {
        let configured: Bool
        let credentialSource: String?
        let audienceType: String?
        let audience: String?
        let webhookPath: String?
        let webhookUrl: String?
        let running: Bool
        let lastStartAt: Double?
        let lastStopAt: Double?
        let lastError: String?
        let probe: GoogleChatProbe?
        let lastProbeAt: Double?
    }

    struct SignalProbe: Codable {
        let ok: Bool
        let status: Int?
        let error: String?
        let elapsedMs: Double?
        let version: String?
    }

    struct SignalStatus: Codable {
        let configured: Bool
        let baseUrl: String
        let running: Bool
        let lastStartAt: Double?
        let lastStopAt: Double?
        let lastError: String?
        let probe: SignalProbe?
        let lastProbeAt: Double?
    }

    struct IMessageProbe: Codable {
        let ok: Bool
        let error: String?
    }

    struct IMessageStatus: Codable {
        let configured: Bool
        let running: Bool
        let lastStartAt: Double?
        let lastStopAt: Double?
        let lastError: String?
        let cliPath: String?
        let dbPath: String?
        let probe: IMessageProbe?
        let lastProbeAt: Double?
    }

    struct ChannelAccountSnapshot: Codable {
        let accountId: String
        let name: String?
        let enabled: Bool?
        let configured: Bool?
        let linked: Bool?
        let running: Bool?
        let connected: Bool?
        let reconnectAttempts: Int?
        let lastConnectedAt: Double?
        let lastError: String?
        let lastStartAt: Double?
        let lastStopAt: Double?
        let lastInboundAt: Double?
        let lastOutboundAt: Double?
        let lastProbeAt: Double?
        let mode: String?
        let dmPolicy: String?
        let allowFrom: [String]?
        let tokenSource: String?
        let botTokenSource: String?
        let appTokenSource: String?
        let baseUrl: String?
        let allowUnmentionedGroups: Bool?
        let cliPath: String?
        let dbPath: String?
        let port: Int?
        let probe: AnyCodable?
        let audit: AnyCodable?
        let application: AnyCodable?
    }

    struct ChannelUiMetaEntry: Codable {
        let id: String
        let label: String
        let detailLabel: String
        let systemImage: String?
    }

    let ts: Double
    let channelOrder: [String]
    let channelLabels: [String: String]
    let channelDetailLabels: [String: String]?
    let channelSystemImages: [String: String]?
    let channelMeta: [ChannelUiMetaEntry]?
    let channels: [String: AnyCodable]
    let channelAccounts: [String: [ChannelAccountSnapshot]]
    let channelDefaultAccountId: [String: String]

    func decodeChannel<T: Decodable>(_ id: String, as type: T.Type) -> T? {
        guard let value = self.channels[id] else { return nil }
        do {
            let data = try JSONEncoder().encode(value)
            return try JSONDecoder().decode(type, from: data)
        } catch {
            return nil
        }
    }
}

struct ConfigSnapshot: Codable {
    struct Issue: Codable {
        let path: String
        let message: String
    }

    let path: String?
    let exists: Bool?
    let raw: String?
    let hash: String?
    let parsed: AnyCodable?
    let valid: Bool?
    let config: [String: AnyCodable]?
    let issues: [Issue]?
}

struct ConfigSchemaLookupChild: Identifiable {
    let key: String
    let path: String
    let typeLabel: String?
    let required: Bool
    let hasChildren: Bool
    let hint: ConfigUiHint?
    let hintPath: String?

    var id: String {
        self.path
    }

    init?(raw: [String: AnyCodable]) {
        guard let key = raw["key"]?.stringValue,
              let path = raw["path"]?.stringValue
        else {
            return nil
        }
        self.key = key
        self.path = path
        if let type = raw["type"]?.stringValue {
            self.typeLabel = type
        } else if let types = raw["type"]?.arrayValue {
            self.typeLabel = types.compactMap(\.stringValue).joined(separator: " / ")
        } else {
            self.typeLabel = nil
        }
        self.required = raw["required"]?.boolValue ?? false
        self.hasChildren = raw["hasChildren"]?.boolValue ?? false
        if let hint = raw["hint"]?.dictionaryValue {
            self.hint = ConfigUiHint(raw: hint.mapValues(\.foundationValue))
        } else {
            self.hint = nil
        }
        self.hintPath = raw["hintPath"]?.stringValue
    }
}

struct ConfigSchemaLookupNode {
    let path: String
    let schema: ConfigSchemaNode
    let hint: ConfigUiHint?
    let hintPath: String?
    let children: [ConfigSchemaLookupChild]
}

@MainActor
@Observable
final class ChannelsStore {
    static let shared = ChannelsStore()

    var snapshot: ChannelsStatusSnapshot? {
        didSet {
            self.decodedChannelCache.removeAll(keepingCapacity: true)
        }
    }

    // Acquisition can fail before a lease exists; the selected revision still owns that error.
    private var failure: (revision: UInt64?, source: Source?, message: String)?
    var lastError: String? {
        get {
            guard let failure, failure.revision == self.gateway.selectedEndpointRevision,
                  failure.source.map(self.owns) != false else { return nil }
            return failure.message
        }
        set {
            self.failure = newValue.map { (self.gateway.selectedEndpointRevision, self.source, $0) }
        }
    }

    var lastSuccess: Date?
    var isRefreshing = false

    var whatsappLoginMessage: String?
    var whatsappLoginQrDataUrl: String?
    var whatsappLoginSessionKey: String?
    var whatsappLoginConnected: Bool?
    var whatsappBusy = false
    var telegramBusy = false

    var configStatus: String?
    var isSavingConfig = false
    var configSchemaTask: Task<Void, Never>?
    var configSchemaLoading: Bool {
        self.configSchemaTask != nil
    }

    var configSchema: ConfigSchemaNode?
    var configLookupRoot: ConfigSchemaLookupNode?
    var configLookupCache: [String: ConfigSchemaLookupNode] = [:]
    // Root recovery must retain another path's failure until that path is retried.
    var configLookupErrors: [String: String] = [:]
    var configLookupTasks: [String: Task<Void, Never>] = [:]
    var configLookupLoadingPaths: Set<String> {
        Set(self.configLookupTasks.keys)
    }

    var configUiHints: [String: ConfigUiHint] = [:]
    var configSchemaSourceKey: String?
    var configTask: Task<Void, Never>?
    var configLoading: Bool {
        self.configTask != nil
    }

    /// Coalesced re-load request while a config fetch is in flight: `refresh`
    /// refetches without overwriting a dirty local draft; `force` overwrites it.
    enum ConfigReloadRequest { case none, refresh, force }
    var configReloadPending: ConfigReloadRequest = .none
    var configDraft: [String: Any] = [:]
    var configDirty = false

    let interval: TimeInterval = 45
    let isPreview: Bool
    let gateway: GatewayConnection
    var source: Source?
    var configDocument: ConfigStore.Document?
    let logger = Logger(subsystem: "ai.openclaw", category: "channels-settings")

    /// Settings and QR sessions survive socket reconnects. A retired selection
    /// must never publish into the replacement Source's state.
    @MainActor
    final class Source: Equatable {
        nonisolated static func == (lhs: Source, rhs: Source) -> Bool {
            lhs === rhs
        }

        let lease: GatewayConnection.ServerLease
        let gateway: GatewayConnection

        init(lease: GatewayConnection.ServerLease, gateway: GatewayConnection) {
            self.lease = lease
            self.gateway = gateway
        }

        var isCurrent: Bool {
            self.gateway.serverLeaseMatchesCurrentRoute(self.lease)
        }

        var cacheKey: String {
            String(describing: ObjectIdentifier(self))
        }
    }

    func owns(_ source: Source) -> Bool {
        self.source === source && source.isCurrent
    }

    func resolveSource(_ expected: Source? = nil) async -> Source? {
        if let expected {
            guard self.owns(expected) else {
                self.logger.info("channel work discarded after the Primary Gateway changed")
                return nil
            }
            return expected
        }
        if let source = self.source, self.owns(source) { return source }
        self.clearSource()
        let revision = self.gateway.selectedEndpointRevision
        do {
            let lease = try await self.gateway.acquireServerLease()
            guard revision == self.gateway.selectedEndpointRevision else {
                self.logger.info("channel work discarded while the Primary Gateway changed")
                return nil
            }
            if let source = self.source, self.owns(source) { return source }
            let source = Source(lease: lease, gateway: self.gateway)
            guard source.isCurrent else { return nil }
            self.source = source
            return source
        } catch {
            self.logger.error("channel Gateway unavailable: \(error.localizedDescription, privacy: .public)")
            if revision == self.gateway.selectedEndpointRevision {
                self.failure = (revision, nil, error.localizedDescription)
            }
            return nil
        }
    }

    func clearSource() {
        if self.source != nil { self.logger.info("channel state retired after the Primary Gateway changed") }
        self.source = nil
        self.snapshot = nil
        self.lastError = nil
        self.lastSuccess = nil
        self.isRefreshing = false
        self.whatsappLoginMessage = nil
        self.whatsappLoginQrDataUrl = nil
        self.whatsappLoginSessionKey = nil
        self.whatsappLoginConnected = nil
        self.whatsappBusy = false
        self.telegramBusy = false
        self.configStatus = nil
        self.isSavingConfig = false
        self.resetConfigSchemaCacheIfSourceChanged("")
        self.resetConfigCacheIfSourceChanged("")
        self.configSourceKey = nil
        self.configSchemaSourceKey = nil
        self.configDocument = nil
    }

    var startCount = 0
    var pollTask: Task<Void, Never>?
    var gatewayPushTask: Task<Void, Never>?
    var configRoot: [String: Any] = [:]
    var configLoaded = false
    var configSourceKey: String?
    @ObservationIgnored private var decodedChannelCache: [String: Any] = [:]

    func channelMetaEntry(_ id: String) -> ChannelsStatusSnapshot.ChannelUiMetaEntry? {
        self.snapshot?.channelMeta?.first(where: { $0.id == id })
    }

    func resolveChannelLabel(_ id: String) -> String {
        if let meta = self.channelMetaEntry(id), !meta.label.isEmpty {
            return meta.label
        }
        if let label = self.snapshot?.channelLabels[id], !label.isEmpty {
            return label
        }
        return id
    }

    func resolveChannelDetailLabel(_ id: String) -> String {
        if let meta = self.channelMetaEntry(id), !meta.detailLabel.isEmpty {
            return meta.detailLabel
        }
        if let detail = self.snapshot?.channelDetailLabels?[id], !detail.isEmpty {
            return detail
        }
        return self.resolveChannelLabel(id)
    }

    func resolveChannelSystemImage(_ id: String) -> String {
        if let meta = self.channelMetaEntry(id), let symbol = meta.systemImage, !symbol.isEmpty {
            return symbol
        }
        if let symbol = self.snapshot?.channelSystemImages?[id], !symbol.isEmpty {
            return symbol
        }
        return "message"
    }

    func orderedChannelIds() -> [String] {
        if let meta = self.snapshot?.channelMeta, !meta.isEmpty {
            return meta.map(\.id)
        }
        return self.snapshot?.channelOrder ?? []
    }

    func decodedChannel<T: Decodable>(_ id: String, as type: T.Type) -> T? {
        let key = "\(id)#\(ObjectIdentifier(type))"
        if let cached = self.decodedChannelCache[key] as? T {
            return cached
        }
        guard let decoded = self.snapshot?.decodeChannel(id, as: type) else {
            return nil
        }
        self.decodedChannelCache[key] = decoded
        return decoded
    }

    func applyWhatsAppLoginWaitResult(_ result: WhatsAppLoginWaitResult) {
        self.whatsappLoginMessage = result.message
        self.whatsappLoginConnected = result.connected
        if result.connected {
            self.whatsappLoginSessionKey = nil
        }
        if let qrDataUrl = result.qrDataUrl {
            self.whatsappLoginQrDataUrl = qrDataUrl
        } else if result.connected {
            self.whatsappLoginQrDataUrl = nil
        }
    }

    init(isPreview: Bool = ProcessInfo.processInfo.isPreview, gateway: GatewayConnection = .shared) {
        self.gateway = gateway
        self.isPreview = isPreview
    }
}
