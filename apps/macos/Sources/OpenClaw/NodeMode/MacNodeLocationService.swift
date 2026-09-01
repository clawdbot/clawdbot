import CoreLocation
import Foundation
import OpenClawKit

@MainActor
final class MacNodeLocationService: NSObject, CLLocationManagerDelegate, ConcurrentLocationServiceCommon {
    enum Error: Swift.Error {
        case timeout
        case unavailable
    }

    private let manager = CLLocationManager()
    private var locationContinuation: CheckedContinuation<CLLocation, Swift.Error>?
    var locationRequestContinuations: [UUID: CheckedContinuation<CLLocation, Swift.Error>] = [:]

    var locationManager: CLLocationManager {
        self.manager
    }

    /// Compatibility witness for the shipped single-waiter protocol; app calls use the
    /// concurrent extension and its per-request continuation dictionary.
    var locationRequestContinuation: CheckedContinuation<CLLocation, Swift.Error>? {
        get { self.locationContinuation }
        set { self.locationContinuation = newValue }
    }

    override init() {
        super.init()
        self.configureLocationManager()
    }

    func currentLocation(
        desiredAccuracy: OpenClawLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation
    {
        guard CLLocationManager.locationServicesEnabled() else {
            throw Error.unavailable
        }
        return try await LocationCurrentRequest.resolve(
            manager: self.manager,
            desiredAccuracy: desiredAccuracy,
            maxAgeMs: maxAgeMs,
            timeoutMs: timeoutMs,
            request: { try await self.requestLocationOnce() },
            withTimeout: { timeoutMs, operation in
                try await self.withTimeout(timeoutMs: timeoutMs) {
                    try await operation()
                }
            })
    }

    private func withTimeout<T: Sendable>(
        timeoutMs: Int,
        operation: @escaping @Sendable () async throws -> T) async throws -> T
    {
        try await AsyncTimeout.withTimeoutMs(
            timeoutMs: timeoutMs,
            onTimeout: { Error.timeout },
            operation: operation)
    }

    // MARK: - CLLocationManagerDelegate (nonisolated for Swift 6 compatibility)

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in
            let continuations = Array(self.locationRequestContinuations.values) + [self.locationContinuation]
                .compactMap(\.self)
            self.locationRequestContinuations.removeAll()
            self.locationContinuation = nil
            if let latest = locations.last {
                for continuation in continuations {
                    continuation.resume(returning: latest)
                }
            } else {
                for continuation in continuations {
                    continuation.resume(throwing: Error.unavailable)
                }
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Swift.Error) {
        let errorCopy = error // Capture error for Sendable compliance
        Task { @MainActor in
            let continuations = Array(self.locationRequestContinuations.values) + [self.locationContinuation]
                .compactMap(\.self)
            self.locationRequestContinuations.removeAll()
            self.locationContinuation = nil
            for continuation in continuations {
                continuation.resume(throwing: errorCopy)
            }
        }
    }
}
