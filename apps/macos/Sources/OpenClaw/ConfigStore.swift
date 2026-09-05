import Foundation
import OpenClawKit
import OpenClawProtocol

enum ConfigStore {
    /// A revision token is useful only with the document and Gateway that issued it.
    @MainActor
    struct Document {
        var root: [String: Any]
        fileprivate let origin: Origin
        fileprivate let hash: String?
        fileprivate let readError: Error?

        var isCurrent: Bool {
            self.origin.isCurrent
        }
    }

    @MainActor
    fileprivate final class Origin {
        let gateway: GatewayConnection
        let revision: UInt64?
        let mode: AppState.ConnectionMode
        let localURL: URL
        var allowsLocalFallback: Bool
        var lease: GatewayConnection.ServerLease?

        init(gateway: GatewayConnection) {
            self.gateway = gateway
            self.revision = gateway.selectedEndpointRevision
            self.mode = AppStateStore.shared.connectionMode
            self.localURL = OpenClawConfigFile.url()
            self.allowsLocalFallback = self.mode != .remote
        }

        var selectionIsCurrent: Bool {
            self.gateway.selectedEndpointRevision == self.revision &&
                AppStateStore.shared.connectionMode == self.mode && OpenClawConfigFile.url() == self.localURL
        }

        var isCurrent: Bool {
            self.selectionIsCurrent && self.lease.map(self.gateway.serverLeaseMatchesCurrentRoute) != false
        }
    }

    struct Overrides {
        var isRemoteMode: (@Sendable () async -> Bool)?
        var loadLocal: (@MainActor @Sendable () -> [String: Any])?
        var saveLocal: (@MainActor @Sendable ([String: Any]) -> Void)?
        var loadRemote: (@MainActor @Sendable () async -> [String: Any])?
        var saveRemote: (@MainActor @Sendable ([String: Any]) async throws -> Void)?
        var saveGateway: (@MainActor @Sendable ([String: Any]) async throws -> Void)?
        #if DEBUG
        /// Isolates focused notification assertions without changing the production sender contract.
        var notificationCenter: NotificationCenter?
        #endif
    }

    private actor OverrideStore {
        var overrides = Overrides()

        func setOverride(_ overrides: Overrides) {
            self.overrides = overrides
        }
    }

    private static let overrideStore = OverrideStore()
    @MainActor
    static func load(gateway: GatewayConnection = .shared) async -> Document {
        let origin = Origin(gateway: gateway)
        let overrides = await self.overrideStore.overrides
        if let isRemoteMode = overrides.isRemoteMode {
            origin.allowsLocalFallback = await !isRemoteMode()
        }
        let remote = !origin.allowsLocalFallback
        guard origin.selectionIsCurrent else {
            return Document(root: [:], origin: origin, hash: nil, readError: self.sourceChanged())
        }
        if let load = remote ? overrides.loadRemote : nil {
            let root = await load()
            return Document(root: root, origin: origin, hash: nil, readError: nil)
        }
        if !remote, let load = overrides.loadLocal {
            return Document(root: load(), origin: origin, hash: nil, readError: nil)
        }
        do {
            let lease = try await gateway.acquireServerLease()
            guard origin.selectionIsCurrent else { throw self.sourceChanged() }
            origin.lease = lease
            let snapshot: ConfigSnapshot = try await gateway.requestDecoded(
                method: .configGet, params: nil, timeoutMs: 8000, ifCurrentRoute: lease.route)
            guard origin.isCurrent else { throw self.sourceChanged() }
            return Document(
                root: snapshot.config?.mapValues { $0.foundationValue } ?? [:],
                origin: origin,
                hash: snapshot.hash,
                readError: nil)
        } catch {
            guard !remote, origin.isCurrent, self.permitsLocalFallback(after: error) else {
                return Document(root: [:], origin: origin, hash: nil, readError: error)
            }
            // An offline local document remains a local-file edit; a later
            // connection must not lend it a different document's revision token.
            origin.lease = nil
            return Document(root: OpenClawConfigFile.loadDict(), origin: origin, hash: nil, readError: nil)
        }
    }

    @MainActor
    static func document(
        snapshot: ConfigSnapshot,
        gateway: GatewayConnection,
        lease: GatewayConnection.ServerLease) -> Document
    {
        let origin = Origin(gateway: gateway)
        origin.lease = lease
        return Document(
            root: snapshot.config?.mapValues { $0.foundationValue } ?? [:],
            origin: origin,
            hash: snapshot.hash,
            readError: nil)
    }

    @MainActor
    static func save(_ document: Document, allowGatewayAuthMutation: Bool = false) async throws {
        let origin = document.origin
        guard origin.isCurrent else { throw self.sourceChanged() }
        if let error = document.readError { throw error }
        let overrides = await self.overrideStore.overrides
        guard origin.isCurrent else { throw self.sourceChanged() }
        if !origin.allowsLocalFallback {
            if let save = overrides.saveRemote {
                try await save(document.root)
            } else {
                try await self.saveToGateway(document, overrides: overrides)
            }
            guard origin.isCurrent else { throw self.sourceChanged() }
        } else if let save = overrides.saveLocal {
            save(document.root)
        } else {
            do {
                if origin.lease == nil, overrides.saveGateway == nil {
                    try self.saveLocal(document, allowGatewayAuthMutation: allowGatewayAuthMutation)
                } else {
                    try await self.saveToGateway(document, overrides: overrides)
                }
            } catch {
                guard origin.isCurrent, self.permitsLocalFallback(after: error) else {
                    throw error
                }
                try self.saveLocal(document, allowGatewayAuthMutation: allowGatewayAuthMutation)
            }
        }
        guard origin.selectionIsCurrent else { throw self.sourceChanged() }
        #if DEBUG
        let notificationCenter = overrides.notificationCenter ?? .default
        #else
        let notificationCenter = NotificationCenter.default
        #endif
        notificationCenter.post(name: .openclawConfigDidChange, object: nil)
    }

    @MainActor
    private static func saveLocal(_ document: Document, allowGatewayAuthMutation: Bool) throws {
        guard document.origin.isCurrent else { throw self.sourceChanged() }
        guard OpenClawConfigFile.saveDict(
            document.root, preserveExistingKeys: true, allowGatewayAuthMutation: allowGatewayAuthMutation)
        else {
            throw NSError(domain: "ConfigStore", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Local config write rejected to protect gateway auth/mode.",
            ])
        }
    }

    private static func sourceChanged() -> Error {
        NSError(domain: "ConfigStore", code: 3, userInfo: [
            NSLocalizedDescriptionKey: "Gateway changed since this config was loaded. Reload it before saving.",
        ])
    }

    private static func permitsLocalFallback(after error: Error) -> Bool {
        if error is CancellationError || error is GatewayConnectAuthError ||
            (error as? GatewayResponseError)?.isAuthorizationFailure == true
        {
            return false
        }
        let nsError = error as NSError
        let message = "\(nsError.domain) \(nsError.localizedDescription)".lowercased()
        let blockedFragments = [
            "invalid_request",
            "invalid request",
            "invalid config",
            "config changed since last load",
            "base hash",
            "basehash",
            "unauthorized",
            "token mismatch",
            "auth",
        ]
        return !blockedFragments.contains { message.contains($0) }
    }

    @MainActor
    private static func saveToGateway(_ document: Document, overrides: Overrides) async throws {
        if let save = overrides.saveGateway {
            try await save(document.root)
            return
        }
        guard let lease = document.origin.lease, document.isCurrent else { throw self.sourceChanged() }
        let data = try JSONSerialization.data(withJSONObject: document.root, options: [.prettyPrinted, .sortedKeys])
        guard let raw = String(data: data, encoding: .utf8) else {
            throw NSError(domain: "ConfigStore", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode config.",
            ])
        }
        var params: [String: AnyCodable] = ["raw": AnyCodable(raw)]
        if let hash = document.hash { params["baseHash"] = AnyCodable(hash) }
        _ = try await document.origin.gateway.request(
            method: GatewayConnection.Method.configSet.rawValue,
            params: params,
            timeoutMs: 10000,
            ifCurrentRoute: lease.route)
    }

    #if DEBUG
    static func _testSetOverrides(_ overrides: Overrides) async {
        await self.overrideStore.setOverride(overrides)
    }

    static func _testClearOverrides() async {
        await self.overrideStore.setOverride(.init())
    }

    #endif
}

extension Notification.Name {
    static let openclawConfigDidChange = Notification.Name("openclaw.config.did-change")
}
