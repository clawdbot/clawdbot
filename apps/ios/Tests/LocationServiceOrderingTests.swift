import CoreLocation
import Foundation
import Testing
import XCTest
@testable import OpenClaw

/// Run only on a fresh, task-owned simulator. The existing callback setter starts
/// CoreLocation monitoring; it never requests authorization, and no location is injected into the OS.
@Suite(.serialized)
@MainActor
struct LocationServiceOrderingTests {
    @Test
    func `one shot state is drained before significant change delivery`() async throws {
        let service = LocationService()
        service.locationManager.delegate = nil
        let latest = CLLocation(latitude: 3, longitude: 4)
        let registered = XCTestExpectation(description: "one shot waiter registered")
        let completed = XCTestExpectation(description: "one shot waiter completed")
        let forwarded = XCTestExpectation(description: "significant change forwarded")
        forwarded.assertForOverFulfill = true
        var result: CLLocation?
        let waiter = Task { @MainActor in
            result = try await withCheckedThrowingContinuation { continuation in
                service.locationRequestContinuation = continuation
                registered.fulfill()
            }
            completed.fulfill()
        }
        defer {
            waiter.cancel()
            service.stopMonitoringSignificantLocationChanges()
            service.locationManager.delegate = nil
            if result == nil, let continuation = service.locationRequestContinuation {
                service.locationRequestContinuation = nil
                continuation.resume(throwing: CancellationError())
            }
        }
        let ready = await XCTWaiter.fulfillment(of: [registered], timeout: 5)
        try #require(ready == .completed)
        service.startMonitoringSignificantLocationChanges { location in
            MainActor.assumeIsolated {
                #expect(service.locationRequestContinuations.isEmpty)
                #expect(service.locationRequestContinuation == nil)
                #expect(location === latest)
                forwarded.fulfill()
            }
        }

        service.locationManager(service.locationManager, didUpdateLocations: [latest])

        let finished = await XCTWaiter.fulfillment(of: [completed, forwarded], timeout: 5)
        try #require(finished == .completed)
        try await waiter.value
        #expect(result === latest)
    }
}
