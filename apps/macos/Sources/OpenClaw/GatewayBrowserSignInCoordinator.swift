import Foundation
import OpenClawKit

enum GatewayBrowserSignInCoordinator {
    static func gatewayURL(from address: String) throws -> URL {
        let address = address.trimmingCharacters(in: .whitespacesAndNewlines)
        let input = address.contains("://") ? address : "https://\(address)"
        guard !address.isEmpty,
              let components = URLComponents(string: input),
              ["https", "http", "wss", "ws"].contains(components.scheme?.lowercased() ?? ""),
              let link = GatewayConnectDeepLink.fromSetupInput(input),
              let url = link.websocketURL
        else { throw MacGatewayProfileError.invalidURL }
        return try MacGatewayProfileStore.canonicalURL(url)
    }

    static func connect(
        name: String,
        address: String,
        token: String,
        password: String) async throws -> MacGatewayProfile
    {
        let url = try self.gatewayURL(from: address)
        let store = MacGatewayProfileStore.shared
        let attempt = try await store.beginBrowserSignIn(url: url)
        do {
            try Task.checkCancellation()
            let hasCredentials = !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                !password.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            if !hasCredentials, url.scheme == "wss" {
                guard var browserURL = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
                    throw MacGatewayProfileError.invalidURL
                }
                browserURL.scheme = "https"
                guard let discoveryURL = browserURL.url else { throw MacGatewayProfileError.invalidURL }
                if let application = try await CloudflareAccessLogin.discover(gatewayURL: discoveryURL) {
                    let session = try await CloudflareAccessLogin.signIn(application: application)
                    try Task.checkCancellation()
                    return try await store.saveBrowserSession(name: name, session: session, attempt: attempt)
                }
            }
            try Task.checkCancellation()
            return try await store.saveConnection(name: name, token: token, password: password, attempt: attempt)
        } catch {
            await store.cancelBrowserSignIn(attempt)
            throw error
        }
    }
}
