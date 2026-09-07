import Foundation

extension GatewayConnection {
    /// The authenticated hello owns browser sign-in discovery; no admin-only
    /// config read or endpoint guess may substitute for that server's identity.
    func controlUiBrowserIdentityURL(config: Config) async throws -> URL? {
        var capturedLease = await self.captureServerLease()
        if capturedLease == nil {
            let route = try await self.captureRequiredRoute()
            guard route.matches(config: config) else { throw CancellationError() }
            _ = try await self.request(method: Method.health.rawValue, params: nil, ifCurrentRoute: route)
            capturedLease = await self.captureServerLease()
            guard await self.isCurrentRoute(route) else { throw CancellationError() }
        }
        guard let lease = capturedLease,
              lease.route.matches(config: config),
              await self.isCurrentServerLease(lease)
        else { throw CancellationError() }
        guard let advertised = self.lastSnapshot?.snapshot.controluiidentityurl else { return nil }
        guard let components = URLComponents(string: advertised),
              components.scheme?.lowercased() == "https",
              components.host?.isEmpty == false,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              let url = components.url
        else { throw URLError(.badURL) }
        return url
    }
}
