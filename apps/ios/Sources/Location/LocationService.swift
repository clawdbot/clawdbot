import CoreLocation
import Foundation
import OpenClawKit

@MainActor
final class LocationService: NSObject, CLLocationManagerDelegate, LocationServiceCommon {
    enum Error: Swift.Error {
        case timeout
        case unavailable
    }

    private let manager = CLLocationManager()
    private var authContinuation: CheckedContinuation<CLAuthorizationStatus, Never>?
    private var locationContinuation: CheckedContinuation<CLLocation, Swift.Error>?
    private var updatesContinuation: AsyncStream<CLLocation>.Continuation?
    private var isStreaming = false
    private var significantLocationCallback: (@Sendable (CLLocation) -> Void)?
    private var isMonitoringSignificantChanges = false

    var locationManager: CLLocationManager {
        self.manager
    }

    var locationRequestContinuation: CheckedContinuation<CLLocation, Swift.Error>? {
        get { self.locationContinuation }
        set { self.locationContinuation = newValue }
    }

    override init() {
        super.init()
        self.configureLocationManager()
    }

    func ensureAuthorization(mode: OpenClawLocationMode) async -> CLAuthorizationStatus {
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
        params: OpenClawLocationGetParams,
        desiredAccuracy: OpenClawLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation
    {
        _ = params
        return try await LocationCurrentRequest.resolve(
            manager: self.manager,
            desiredAccuracy: desiredAccuracy,
            maxAgeMs: maxAgeMs,
            timeoutMs: timeoutMs,
            request: { try await self.requestLocationOnce() },
            withTimeout: { timeoutMs, operation in
                try await self.withTimeout(timeoutMs: timeoutMs, operation: operation)
            })
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

    func startLocationUpdates(
        desiredAccuracy: OpenClawLocationAccuracy,
        significantChangesOnly: Bool) -> AsyncStream<CLLocation>
    {
        self.stopLocationUpdates()

        self.manager.desiredAccuracy = LocationCurrentRequest.accuracyValue(desiredAccuracy)
        self.manager.pausesLocationUpdatesAutomatically = true
        self.manager.allowsBackgroundLocationUpdates = true

        self.isStreaming = true
        if significantChangesOnly {
            self.manager.startMonitoringSignificantLocationChanges()
        } else {
            self.manager.startUpdatingLocation()
        }

        return AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            self.updatesContinuation = continuation
            continuation.onTermination = { @Sendable _ in
                Task { @MainActor in
                    self.stopLocationUpdates()
                }
            }
        }
    }

    func stopLocationUpdates() {
        guard self.isStreaming else { return }
        self.isStreaming = false
        self.manager.stopUpdatingLocation()
        self.manager.stopMonitoringSignificantLocationChanges()
        self.updatesContinuation?.finish()
        self.updatesContinuation = nil
    }

    func startMonitoringSignificantLocationChanges(onUpdate: @escaping @Sendable (CLLocation) -> Void) {
        self.significantLocationCallback = onUpdate
        guard !self.isMonitoringSignificantChanges else { return }
        self.isMonitoringSignificantChanges = true
        self.manager.startMonitoringSignificantLocationChanges()
    }

    func stopMonitoringSignificantLocationChanges() {
        guard self.isMonitoringSignificantChanges else { return }
        self.isMonitoringSignificantChanges = false
        self.significantLocationCallback = nil
        self.manager.stopMonitoringSignificantLocationChanges()
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
            // Resolve the one-shot continuation first (if any).
            if let cont = self.locationContinuation {
                self.locationContinuation = nil
                if let latest = locs.last {
                    cont.resume(returning: latest)
                } else {
                    cont.resume(throwing: Error.unavailable)
                }
                // Don't return — also forward to significant-change callback below
                // so both consumers receive updates when both are active.
            }
            if let callback = self.significantLocationCallback, let latest = locs.last {
                callback(latest)
            }
            if let latest = locs.last, let updates = self.updatesContinuation {
                updates.yield(latest)
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
