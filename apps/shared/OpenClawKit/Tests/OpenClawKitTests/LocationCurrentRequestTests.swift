import CoreLocation
import Foundation
import Testing
@testable import OpenClawKit

private final class CachedLocationManager: CLLocationManager, @unchecked Sendable {
    private let cachedLocation: CLLocation?

    init(cachedLocation: CLLocation?) {
        self.cachedLocation = cachedLocation
        super.init()
    }

    override var location: CLLocation? {
        self.cachedLocation
    }
}

struct LocationCurrentRequestTests {
    @Test(arguments: [0, 1000])
    @MainActor
    func `future cached locations never satisfy a maximum age`(maxAgeMs: Int) async throws {
        let cached = self.location(timestamp: Date().addingTimeInterval(5))
        let fresh = CLLocation(latitude: 3, longitude: 4)

        let result = try await self.resolve(cached: cached, fresh: fresh, maxAgeMs: maxAgeMs)

        #expect(result === fresh)
    }

    @Test
    @MainActor
    func `recent past cached locations still satisfy their maximum age`() async throws {
        let cached = self.location(timestamp: Date().addingTimeInterval(-0.2))
        let fresh = CLLocation(latitude: 3, longitude: 4)

        let result = try await self.resolve(cached: cached, fresh: fresh, maxAgeMs: 1000)

        #expect(result === cached)
    }

    @Test
    @MainActor
    func `expired cached locations request a fresh fix`() async throws {
        let cached = self.location(timestamp: Date().addingTimeInterval(-2))
        let fresh = CLLocation(latitude: 3, longitude: 4)

        let result = try await self.resolve(cached: cached, fresh: fresh, maxAgeMs: 1000)

        #expect(result === fresh)
    }

    private func location(timestamp: Date) -> CLLocation {
        CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: 1, longitude: 2),
            altitude: 0,
            horizontalAccuracy: 1,
            verticalAccuracy: 1,
            timestamp: timestamp)
    }

    @MainActor
    private func resolve(cached: CLLocation, fresh: CLLocation, maxAgeMs: Int) async throws -> CLLocation {
        try await LocationCurrentRequest.resolve(
            manager: CachedLocationManager(cachedLocation: cached),
            desiredAccuracy: .balanced,
            maxAgeMs: maxAgeMs,
            timeoutMs: 1000,
            request: { fresh },
            withTimeout: { _, operation in try await operation() })
    }
}
