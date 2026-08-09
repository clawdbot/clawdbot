import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct NodesStoreTests {
    @Test func `local node identity is prepared once`() async {
        let loader = LocalNodeIdentityLoader(results: ["node-id"])
        let store = NodesStore(
            localNodeIdentityProfile: .node,
            localNodeIDLoader: loader.load)

        async let first: Void = store.prepareLocalNodeIdentity()
        async let second: Void = store.prepareLocalNodeIdentity()
        _ = await (first, second)
        await store.prepareLocalNodeIdentity()

        #expect(store.localNodeIdentityState == .available("node-id"))
        #expect(loader.loadedProfiles == [.node])
    }

    @Test func `unavailable local node identity can be retried`() async {
        let loader = LocalNodeIdentityLoader(results: [nil, "node-id"])
        let store = NodesStore(
            localNodeIdentityProfile: .primary,
            localNodeIDLoader: loader.load)

        await store.prepareLocalNodeIdentity()
        #expect(store.localNodeIdentityState == .unavailable)

        await store.prepareLocalNodeIdentity()
        #expect(store.localNodeIdentityState == .available("node-id"))
        #expect(loader.loadedProfiles == [.primary, .primary])
    }
}

private final class LocalNodeIdentityLoader: @unchecked Sendable {
    private let lock = NSLock()
    private var results: [String?]
    private var profiles: [GatewayDeviceIdentityProfile] = []

    init(results: [String?]) {
        self.results = results
    }

    var loadedProfiles: [GatewayDeviceIdentityProfile] {
        self.lock.withLock { self.profiles }
    }

    func load(profile: GatewayDeviceIdentityProfile) -> String? {
        self.lock.withLock {
            self.profiles.append(profile)
            return self.results.isEmpty ? nil : self.results.removeFirst()
        }
    }
}
