import CryptoKit
import Foundation
import WebKit

/// One saved Gateway owns its WebKit state. Serializing replacement prevents an
/// old cookie write from restoring the previous account after sign-in or removal.
@MainActor
final class DashboardBrowserSessionStore {
    @MainActor
    struct Lease {
        fileprivate let owner: DashboardBrowserSessionStore
        fileprivate let revision: UInt64
        let session: GatewayBrowserSession?

        var isCurrent: Bool {
            self.owner.revision == self.revision
        }

        func prepare(for url: URL, in contentController: WKUserContentController) async throws {
            try self.session?.validate(for: url)
            guard self.isCurrent else { throw GatewayBrowserSessionError.superseded }
            try await self.owner.preparation?.value
            try Task.checkCancellation()
            guard self.isCurrent else { throw GatewayBrowserSessionError.superseded }
            try self.session?.validate(for: url)
            if let rule = self.owner.cookieRule {
                contentController.add(rule)
            }
            try await self.owner.publishCookie(revision: self.revision).value
            try Task.checkCancellation()
            guard self.isCurrent else { throw GatewayBrowserSessionError.superseded }
            try self.session?.validate(for: url)
        }
    }

    let dataStore: WKWebsiteDataStore
    private var session: GatewayBrowserSession?
    private final class Ownership {
        weak var store: DashboardBrowserSessionStore?
        var principal: String?
        var requiresRemoval = false
    }

    private static var persistentOwners: [UUID: Ownership] = [:]
    private let ownership: Ownership
    private var revision: UInt64 = 0
    private var preparation: Task<Void, Error>?
    private var cookieRule: WKContentRuleList?
    private var publishedRevision: UInt64?

    convenience init(dataStore: WKWebsiteDataStore) {
        self.init(dataStore: dataStore, ownership: Ownership())
    }

    private init(dataStore: WKWebsiteDataStore, ownership: Ownership) {
        self.dataStore = dataStore
        self.ownership = ownership
    }

    static func persistent(
        profileID: String,
        registryNamespace: String,
        currentSession: GatewayBrowserSession? = nil) -> DashboardBrowserSessionStore
    {
        let id = self.identifier(profileID: profileID, registryNamespace: registryNamespace)
        let ownership = self.persistentOwners[id] ?? Ownership()
        // MacGatewayProfileStore clears data before publishing a changed Keychain
        // principal. That current session owns persisted data even after a cold
        // restart with no cookie; pending removals must never be overridden.
        if ownership.principal == nil, !ownership.requiresRemoval {
            ownership.principal = currentSession?.browserDataPrincipal
        }
        if let store = ownership.store { return store }
        let store = DashboardBrowserSessionStore(dataStore: WKWebsiteDataStore(forIdentifier: id), ownership: ownership)
        ownership.store = store
        self.persistentOwners[id] = ownership
        return store
    }

    static func prepareProfileChange(
        profileID: String,
        registryNamespace: String,
        previous: GatewayBrowserSession?,
        next: GatewayBrowserSession?,
        ifCurrent: @Sendable () -> Bool) async throws
    {
        guard previous != nil || next != nil else { return }
        try Task.checkCancellation()
        guard ifCurrent() else { throw GatewayBrowserSessionError.superseded }
        let store = self.persistent(profileID: profileID, registryNamespace: registryNamespace)
        let samePrincipal = previous != nil && previous?.browserDataPrincipal == next?.browserDataPrincipal
        let preparation = samePrincipal
            ? store.invalidate(previousPrincipal: previous?.browserDataPrincipal)
            : store.removeData()
        let revision = store.revision
        try await preparation.value
        try Task.checkCancellation()
        guard ifCurrent(), store.revision == revision else { throw GatewayBrowserSessionError.superseded }
        store.ownership.principal = next?.browserDataPrincipal
    }

    static func identifier(profileID: String, registryNamespace: String) -> UUID {
        // Named app profiles share a WebKit container. Match the Keychain
        // registry namespace so one process cannot replace another's cookies.
        let owner = "\(registryNamespace.utf8.count):\(registryNamespace)\(profileID)"
        let bytes = Array(SHA256.hash(data: Data("openclaw.dashboard.profile:\(owner)".utf8)).prefix(16))
        return UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
    }

    func lease(for session: GatewayBrowserSession?) -> Lease {
        if self.revision == 0 || self.session != session {
            self.replaceSession(session)
        }
        return Lease(owner: self, revision: self.revision, session: session)
    }

    @discardableResult
    func invalidate(previousPrincipal: String? = nil) -> Task<Void, Error> {
        if self.ownership.principal == nil { self.ownership.principal = previousPrincipal }
        return self.replaceSession(nil)
    }

    func expire(_ session: GatewayBrowserSession) {
        guard self.session == session, session.expiresAt <= Date() else { return }
        self.invalidate()
    }

    @discardableResult
    func removeData() -> Task<Void, Error> {
        self.ownership.requiresRemoval = true
        return self.replaceSession(nil)
    }

    @discardableResult
    private func replaceSession(_ session: GatewayBrowserSession?) -> Task<Void, Error> {
        let principal = session?.browserDataPrincipal
        if let previous = self.ownership.principal, let principal, previous != principal {
            self.ownership.requiresRemoval = true
        }
        self.revision &+= 1
        let revision = self.revision
        self.session = session
        self.cookieRule = nil
        self.publishedRevision = nil
        let previous = self.preparation
        let preparation = Task { @MainActor in
            // WebKit mutations cannot be cancelled once submitted. A successor
            // waits for the prior write, then clears it before publishing its cookie.
            _ = await previous?.result
            guard self.revision == revision else { throw GatewayBrowserSessionError.superseded }
            // WebKit returns an immutable mapped rule snapshot per compilation;
            // replacing this bounded cache entry does not change other profiles.
            let rule: WKContentRuleList? = if let session {
                try await WKContentRuleListStore.default().compileContentRuleList(
                    forIdentifier: "openclaw.gateway-cookie-origin",
                    encodedContentRuleList: Self.cookieRules(for: session.origin))
            } else {
                nil
            }
            let cookies = await self.dataStore.httpCookieStore.allCookies()
            guard self.revision == revision else { throw GatewayBrowserSessionError.superseded }
            let current = cookies.filter { $0.name == "CF_Authorization" }
            let samePrincipal = principal != nil && principal == self.ownership.principal
            let clearWebsiteData = self.ownership.requiresRemoval ||
                (session != nil && !samePrincipal)
            if clearWebsiteData {
                await self.dataStore.removeData(
                    ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
            } else {
                // Credential retirement must stop old workers and cookie use,
                // while same-account renewals retain website preferences.
                await self.dataStore.removeData(
                    ofTypes: [WKWebsiteDataTypeServiceWorkerRegistrations], modifiedSince: .distantPast)
                for cookie in current {
                    await self.dataStore.httpCookieStore.deleteCookie(cookie)
                }
            }
            guard self.revision == revision else { throw GatewayBrowserSessionError.superseded }
            // A superseded task cannot consume a pending account-data removal.
            if clearWebsiteData { self.ownership.requiresRemoval = false
                self.ownership.principal = nil
            }
            if let principal { self.ownership.principal = principal }
            self.cookieRule = rule
        }
        self.preparation = preparation
        return preparation
    }

    private func publishCookie(revision: UInt64) -> Task<Void, Error> {
        if self.publishedRevision == revision, let preparation { return preparation }
        self.publishedRevision = revision
        let previous = self.preparation
        let preparation = Task { @MainActor in
            try await previous?.value
            guard self.revision == revision else { throw GatewayBrowserSessionError.superseded }
            // Cookie matching ignores ports. Install the resource-layer policy on
            // every dashboard controller before exposing its issuer credential.
            if let cookie = try self.session?.cookie() {
                await self.dataStore.httpCookieStore.setCookie(cookie)
            }
            guard self.revision == revision else { throw GatewayBrowserSessionError.superseded }
        }
        self.preparation = preparation
        return preparation
    }

    private static func cookieRules(for origin: URL) throws -> String {
        guard let originHost = origin.host() else { throw GatewayBrowserSessionError.invalidSession }
        let host = NSRegularExpression.escapedPattern(for: originHost)
        let port = origin.port.map { ":\($0)" } ?? "(:443)?"
        let rules: [[String: Any]] = [
            ["trigger": ["url-filter": ".*"], "action": ["type": "block-cookies"]],
        ] + ["https", "wss"].map { scheme in
            [
                "trigger": ["url-filter": "^\(scheme)://\(host)\(port)/"],
                "action": ["type": "ignore-previous-rules"],
            ]
        }
        guard let encoded = try String(data: JSONSerialization.data(withJSONObject: rules), encoding: .utf8)
        else { throw GatewayBrowserSessionError.invalidSession }
        return encoded
    }
}
