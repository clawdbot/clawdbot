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
    private var revision: UInt64 = 0
    private var preparation: Task<Void, Error>?
    private var cookieRule: WKContentRuleList?
    private var publishedRevision: UInt64?

    init(dataStore: WKWebsiteDataStore) {
        self.dataStore = dataStore
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
    func invalidate() -> Task<Void, Error> {
        self.replaceSession(nil, clearWebsiteData: true)
    }

    @discardableResult
    private func replaceSession(
        _ session: GatewayBrowserSession?, clearWebsiteData: Bool = false) -> Task<Void, Error>
    {
        let clearWebsiteData = clearWebsiteData || self.session != nil
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
            let cookie = try session?.cookie()
            let current = cookies.filter { $0.name == "CF_Authorization" }
            if !clearWebsiteData, let cookie, current.count == 1,
               current[0].value == cookie.value, current[0].domain == cookie.domain,
               current[0].path == cookie.path, current[0].isSecure, current[0].isHTTPOnly
            {
                // Retire workers from an earlier process before re-publishing the
                // cookie under this controller's request policy. Keep UI preferences.
                await self.dataStore.removeData(
                    ofTypes: [WKWebsiteDataTypeServiceWorkerRegistrations], modifiedSince: .distantPast)
                for cookie in current {
                    await self.dataStore.httpCookieStore.deleteCookie(cookie)
                }
            } else if clearWebsiteData || cookie != nil || !current.isEmpty {
                // Account replacement also retires cached profile data and service
                // workers; changing only the cookie leaves the old person's UI state.
                await self.dataStore.removeData(
                    ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
            }
            guard self.revision == revision else { throw GatewayBrowserSessionError.superseded }
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
