import Foundation
import OpenClawChatUI

/// Builds the gateway-scoped facade over the two installation-wide databases
/// shared with iOS through OpenClawKit.
enum MacChatTranscriptCache {
    struct Context {
        let store: OpenClawChatSQLiteTranscriptCache
        let routingIdentity: OpenClawChatSessionRoutingIdentity?
    }

    /// Every chat window for one gateway must share the same outbox actor.
    /// Otherwise a newly opened window can mistake another live window's
    /// claimed send for crash residue during its first recovery pass.
    @MainActor private static var databasesByDirectory: [String: OpenClawClientDatabases] = [:]
    @MainActor private static var storesByKey: [String: OpenClawChatSQLiteTranscriptCache] = [:]

    /// Stable identity of the gateway this app talks to, derivable offline
    /// (the cache pre-paints before any connection is up). Keys must not
    /// collide across gateways:
    /// - local mode keys on the gateway state dir, the store that owns local
    ///   session data: distinct profiles (distinct `OPENCLAW_STATE_DIR`) never
    ///   share cached transcripts even when they reuse the same port;
    /// - remote/direct keys on the full canonical remote URL (scheme, host,
    ///   resolved port, path, query), since one origin can route to several
    ///   gateways by path;
    /// - remote/ssh keys on the SSH target plus the resolved remote gateway
    ///   port (one SSH target can front several gateways on different ports).
    ///   The tunneled 127.0.0.1 URL is per-launch and deliberately never used
    ///   as identity.
    static func gatewayID(
        mode: AppState.ConnectionMode,
        localStateDir: URL,
        remoteTransport: AppState.RemoteTransport,
        directURL: URL?,
        sshTarget: String,
        sshRemotePort: Int) -> String?
    {
        switch mode {
        case .unconfigured:
            return nil
        case .local:
            // Canonicalize so /var vs /private/var style aliases of the same
            // state dir never split one gateway's cache into two scopes.
            return "local:\(localStateDir.resolvingSymlinksInPath().standardizedFileURL.path)"
        case .remote:
            switch remoteTransport {
            case .direct:
                guard let directURL,
                      let scheme = directURL.scheme?.lowercased(),
                      let host = directURL.host?.lowercased(),
                      !host.isEmpty
                else {
                    return nil
                }
                guard let port = GatewayRemoteConfig.defaultPort(for: directURL) else { return nil }
                // Keep path/query: one origin can front several gateways via
                // reverse-proxy routing, and the app connects to the full URL.
                // Percent-encoded forms, not URL.path: decoding would collapse
                // distinct request paths like /team%2Fa and /team/a.
                // Auth is intentionally not part of the identity: gateway
                // transcripts are not partitioned per token/password principal,
                // and keying on credentials would drop the cache on rotation.
                guard let components = URLComponents(url: directURL, resolvingAgainstBaseURL: false) else {
                    return nil
                }
                let query = components.percentEncodedQuery.map { "?\($0)" } ?? ""
                return "remote:\(scheme)://\(host):\(port)\(components.percentEncodedPath)\(query)"
            case .ssh:
                let target = sshTarget.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !target.isEmpty else { return nil }
                return "ssh:\(target):\(sshRemotePort)"
            }
        }
    }

    /// Offline transcript cache scoped to the currently configured gateway.
    /// Nil when the app is unconfigured or the remote target cannot be
    /// resolved, so foreign rows can never leak into another gateway's scope.
    /// Concrete return type: the same SQLite store also backs the offline
    /// command outbox, and callers wire both protocol facets from one instance.
    @MainActor
    static func currentGatewayID() -> String? {
        let root = OpenClawConfigFile.loadDict()
        let mode = ConnectionModeResolver.resolve(root: root).mode
        let resolution = GatewayRemoteConfig.resolveTransportResolution(root: root)
        let sshTarget = CommandResolver.connectionSettings(configRoot: root).target
        // Mirror the tunnel's remote-port resolution (RemotePortTunnel.create)
        // so the identity matches the gateway the forward actually reaches.
        let defaultRemotePort = GatewayEnvironment.gatewayPort()
        let sshHost = CommandResolver.parseSSHTarget(sshTarget)?.host ?? ""
        let sshRemotePort = RemotePortTunnel.resolveRemotePortOverride(
            defaultRemotePort: defaultRemotePort,
            for: sshHost) ?? defaultRemotePort
        return self.gatewayID(
            mode: mode,
            localStateDir: OpenClawConfigFile.stateDirURL(),
            remoteTransport: resolution.transport,
            directURL: resolution.directURL,
            sshTarget: sshTarget,
            sshRemotePort: sshRemotePort)
    }

    /// Loads the small process-stable routing fact before Chat constructs its
    /// view model, so cache partitioning and offline sends never bootstrap
    /// against a nil agent.
    @MainActor
    static func makeContext() -> Context? {
        guard let gatewayID = currentGatewayID() else { return nil }
        return self.makeContext(gatewayID: gatewayID)
    }

    /// Explicit profile context for windows whose route is independent of the app-wide gateway.
    @MainActor
    static func makeContext(gatewayID: String) -> Context? {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else {
            return nil
        }
        let root = base.appendingPathComponent("OpenClaw", isDirectory: true)
        let databaseDirectoryURL = root.appendingPathComponent("databases", isDirectory: true)
        guard let databases = self.databases(
            directoryURL: databaseDirectoryURL,
            legacyDirectoryURL: root)
        else { return nil }
        return Context(
            store: self.store(databases: databases, gatewayID: gatewayID),
            routingIdentity: databases.loadSessionRoutingIdentity(gatewayID: gatewayID))
    }

    @MainActor
    static func store(databaseDirectoryURL: URL, gatewayID: String) -> OpenClawChatSQLiteTranscriptCache? {
        guard let databases = self.databases(
            directoryURL: databaseDirectoryURL,
            legacyDirectoryURL: databaseDirectoryURL)
        else { return nil }
        return self.store(databases: databases, gatewayID: gatewayID)
    }

    @MainActor
    private static func store(
        databases: OpenClawClientDatabases,
        gatewayID: String) -> OpenClawChatSQLiteTranscriptCache
    {
        let key = "\(databases.directoryURL.standardizedFileURL.path)|\(gatewayID)"
        if let store = storesByKey[key] {
            return store
        }
        let store = databases.store(gatewayID: gatewayID)
        self.storesByKey[key] = store
        return store
    }

    @MainActor
    private static func databases(
        directoryURL: URL,
        legacyDirectoryURL: URL) -> OpenClawClientDatabases?
    {
        let key = directoryURL.standardizedFileURL.path
        if let databases = databasesByDirectory[key] {
            // macOS does not yet have a complete multi-gateway pairing
            // registry. Unknown ownership imports all non-forgotten legacy
            // gateways and never commits a cancelable staged removal.
            databases.resolvePendingGatewayRemovals()
            databases.retryLegacyImport()
            return databases
        }
        guard let databases = try? OpenClawClientDatabases(
            directoryURL: directoryURL,
            legacyDirectoryURLs: [legacyDirectoryURL])
        else { return nil }
        self.databasesByDirectory[key] = databases
        return databases
    }
}
