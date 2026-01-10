import ClawdbotKit
import CoreLocation
import Foundation

@MainActor
final class LocationService: NSObject, CLLocationManagerDelegate {
    enum Error: Swift.Error {
        case timeout
        case unavailable
    }

    private let manager = CLLocationManager()
    private var authContinuation: CheckedContinuation<CLAuthorizationStatus, Never>?
    private var locationContinuation: CheckedContinuation<CLLocation, Swift.Error>?

    override init() {
        super.init()
        self.manager.delegate = self
        self.manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    func authorizationStatus() -> CLAuthorizationStatus {
        self.manager.authorizationStatus
    }

    func accuracyAuthorization() -> CLAccuracyAuthorization {
        if #available(iOS 14.0, *) {
            return self.manager.accuracyAuthorization
        }
        return .fullAccuracy
    }

    func ensureAuthorization(mode: ClawdbotLocationMode) async -> CLAuthorizationStatus {
        guard CLLocationManager.locationServicesEnabled() else { return .denied }

        let status = self.manager.authorizationStatus
        if status == .notDetermined {
            self.manager.requestWhenInUseAuthorization()
            let updated = await self.awaitAuthorizationChange()
            if mode != .always { return updated }
        }

        if mode == .always {
            let current = self.manager.authorizationStatus
            if current == .authorizedWhenInUse {
                self.manager.requestAlwaysAuthorization()
                return await self.awaitAuthorizationChange()
            }
            return current
        }

        return self.manager.authorizationStatus
    }

    func currentLocation(
        params: ClawdbotLocationGetParams,
        desiredAccuracy: ClawdbotLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation
    {
        let now = Date()
        if let maxAgeMs,
           let cached = self.manager.location,
           now.timeIntervalSince(cached.timestamp) * 1000 <= Double(maxAgeMs)
        {
            return cached
        }

        self.manager.desiredAccuracy = Self.accuracyValue(desiredAccuracy)
        let timeout = max(0, timeoutMs ?? 10000)
        return try await self.withTimeout(timeoutMs: timeout) {
            try await self.requestLocation()
        }
    }

    private func requestLocation() async throws -> CLLocation {
        try await withCheckedThrowingContinuation { cont in
            self.locationContinuation = cont
            self.manager.requestLocation()
        }
    }

    private func awaitAuthorizationChange() async -> CLAuthorizationStatus {
        await withCheckedContinuation { cont in
            self.authContinuation = cont
        }
    }

    private func withTimeout<T: Sendable>(
        timeoutMs: Int,
        operation: @escaping @Sendable () async throws -> T) async throws -> T
    {
        try await AsyncTimeout.withTimeoutMs(timeoutMs: timeoutMs, onTimeout: { Error.timeout }, operation: operation)
    }

    private static func accuracyValue(_ accuracy: ClawdbotLocationAccuracy) -> CLLocationAccuracy {
        switch accuracy {
        case .coarse:
            kCLLocationAccuracyKilometer
        case .balanced:
            kCLLocationAccuracyHundredMeters
        case .precise:
            kCLLocationAccuracyBest
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            if let cont = self.authContinuation {
                self.authContinuation = nil
                cont.resume(returning: status)
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let locs = locations
        Task { @MainActor in
            guard let cont = self.locationContinuation else { return }
            self.locationContinuation = nil
            if let latest = locs.last {
                cont.resume(returning: latest)
            } else {
                cont.resume(throwing: Error.unavailable)
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Swift.Error) {
        let err = error
        Task { @MainActor in
            guard let cont = self.locationContinuation else { return }
            self.locationContinuation = nil
            cont.resume(throwing: err)
        }
    }
}
