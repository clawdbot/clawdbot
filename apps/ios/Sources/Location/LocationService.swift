import CoreLocation
import Foundation
import OpenClawKit
import UIKit

@MainActor
final class LocationService: NSObject, CLLocationManagerDelegate, ConcurrentLocationServiceCommon {
    enum Error: Swift.Error {
        case timeout
        case unavailable
    }

    private let manager = CLLocationManager()
    private struct AuthorizationWait {
        let requiresDeterminedStatus: Bool
        let continuation: CheckedContinuation<CLAuthorizationStatus, Never>
    }

    private var authorizationWaits: [UUID: AuthorizationWait] = [:]
    private var locationContinuation: CheckedContinuation<CLLocation, Swift.Error>?
    var locationRequestContinuations: [UUID: CheckedContinuation<CLLocation, Swift.Error>] = [:]
    private var cachedAuthorizationSnapshot = LocationAuthorizationSnapshot.undetermined
    private var authorizationChangeHandler: (@MainActor @Sendable (LocationAuthorizationSnapshot) -> Void)?
    private var significantLocationCallback: (@Sendable (CLLocation) -> Void)?
    private var isMonitoringSignificantChanges = false

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

    static func servicesEnabled() async -> Bool {
        // The global service check performs blocking XPC; keep it off the UI actor.
        await Task.detached(priority: .utility) {
            CLLocationManager.locationServicesEnabled()
        }.value
    }

    func authorizationStatus() -> CLAuthorizationStatus {
        self.cachedAuthorizationSnapshot.authorizationStatus
    }

    func accuracyAuthorization() -> CLAccuracyAuthorization {
        self.cachedAuthorizationSnapshot.accuracyAuthorization
    }

    func authorizationSnapshot() -> LocationAuthorizationSnapshot {
        self.cachedAuthorizationSnapshot
    }

    func ensureAuthorization(
        mode: OpenClawLocationMode,
        isCurrent: @MainActor () -> Bool) async -> CLAuthorizationStatus
    {
        guard !Task.isCancelled, isCurrent() else { return self.authorizationStatus() }
        guard CLLocationManager.locationServicesEnabled() else { return .denied }

        let status = self.authorizationStatus()
        if status == .notDetermined {
            let updated = await self.requestAuthorization(requiresDeterminedStatus: true, isCurrent: isCurrent) {
                self.manager.requestWhenInUseAuthorization()
            }
            if mode != .always { return updated }
        }

        if mode == .always {
            let current = self.authorizationStatus()
            if current == .authorizedWhenInUse {
                return await self.requestAuthorization(requiresDeterminedStatus: false, isCurrent: isCurrent) {
                    self.manager.requestAlwaysAuthorization()
                }
            }
            return current
        }

        return self.authorizationStatus()
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

    private func requestAuthorization(
        requiresDeterminedStatus: Bool,
        isCurrent: @MainActor () -> Bool,
        request: () -> Void) async -> CLAuthorizationStatus
    {
        await withCheckedContinuation { cont in
            // Revalidate before each OS prompt, including Always escalation after an awaited grant.
            guard !Task.isCancelled, isCurrent() else {
                cont.resume(returning: self.authorizationStatus())
                return
            }
            let waitID = UUID()
            // A replacement document can request permission while a retired request still awaits the OS.
            self.authorizationWaits[waitID] = AuthorizationWait(
                requiresDeterminedStatus: requiresDeterminedStatus,
                continuation: cont)
            // Install the waiter before requesting permission so a fast delegate callback cannot be lost.
            request()
            Task { @MainActor in
                let clock = ContinuousClock()
                let noPromptDeadline = clock.now.advanced(by: .milliseconds(1500))
                var activeUndeterminedDeadline: ContinuousClock.Instant?
                var observedPrompt = UIApplication.shared.applicationState != .active
                // A slow system prompt must not trigger the no-callback fallback. Once iOS makes
                // the app inactive, wait until the user dismisses the prompt and the app returns.
                while self.authorizationWaits[waitID] != nil {
                    try? await Task.sleep(for: .milliseconds(100))
                    let applicationIsActive = UIApplication.shared.applicationState == .active
                    if !applicationIsActive {
                        observedPrompt = true
                        activeUndeterminedDeadline = nil
                        continue
                    }
                    guard observedPrompt || clock.now >= noPromptDeadline else { continue }
                    let status = self.authorizationStatus()
                    if Self.shouldCompleteAuthorizationWait(
                        status: status,
                        requiresDeterminedStatus: requiresDeterminedStatus)
                    {
                        self.finishAuthorizationWait(waitID: waitID, status: status)
                        continue
                    }
                    if observedPrompt, activeUndeterminedDeadline == nil {
                        activeUndeterminedDeadline = clock.now.advanced(by: .milliseconds(1500))
                    }
                    let fallbackDeadline = activeUndeterminedDeadline ?? noPromptDeadline
                    guard clock.now >= fallbackDeadline else { continue }
                    self.finishAuthorizationWait(
                        waitID: waitID,
                        status: status,
                        allowUndeterminedFallback: true)
                }
            }
        }
    }

    nonisolated static func shouldCompleteAuthorizationWait(
        status: CLAuthorizationStatus,
        requiresDeterminedStatus: Bool,
        allowUndeterminedFallback: Bool = false) -> Bool
    {
        allowUndeterminedFallback || !requiresDeterminedStatus || status != .notDetermined
    }

    private func finishAuthorizationWait(
        waitID: UUID,
        status: CLAuthorizationStatus,
        allowUndeterminedFallback: Bool = false)
    {
        guard let wait = self.authorizationWaits[waitID] else { return }
        guard Self.shouldCompleteAuthorizationWait(
            status: status,
            requiresDeterminedStatus: wait.requiresDeterminedStatus,
            allowUndeterminedFallback: allowUndeterminedFallback)
        else { return }
        self.authorizationWaits.removeValue(forKey: waitID)
        wait.continuation.resume(returning: status)
    }

    private func withTimeout<T: Sendable>(
        timeoutMs: Int,
        operation: @escaping @Sendable () async throws -> T) async throws -> T
    {
        try await AsyncTimeout.withTimeoutMs(timeoutMs: timeoutMs, onTimeout: { Error.timeout }, operation: operation)
    }

    func startMonitoringSignificantLocationChanges(onUpdate: @escaping @Sendable (CLLocation) -> Void) {
        self.significantLocationCallback = onUpdate
        guard !self.isMonitoringSignificantChanges else { return }
        self.isMonitoringSignificantChanges = true
        self.manager.startMonitoringSignificantLocationChanges()
    }

    func setBackgroundLocationUpdatesEnabled(_ enabled: Bool) {
        self.manager.allowsBackgroundLocationUpdates = enabled
    }

    func setAuthorizationChangeHandler(
        _ handler: @escaping @MainActor @Sendable (LocationAuthorizationSnapshot) -> Void)
    {
        self.authorizationChangeHandler = handler
    }

    func stopMonitoringSignificantLocationChanges() {
        self.significantLocationCallback = nil
        self.isMonitoringSignificantChanges = false
        self.manager.stopMonitoringSignificantLocationChanges()
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        // Apple guarantees this callback for the initial state and every authorization
        // change. Cache both values here so UI construction never performs synchronous XPC.
        let snapshot = LocationAuthorizationSnapshot(
            authorizationStatus: manager.authorizationStatus,
            accuracyAuthorization: manager.accuracyAuthorization)
        Task { @MainActor in
            self.cachedAuthorizationSnapshot = snapshot
            self.authorizationChangeHandler?(snapshot)
            for waitID in Array(self.authorizationWaits.keys) {
                self.finishAuthorizationWait(waitID: waitID, status: snapshot.authorizationStatus)
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let locs = locations
        Task { @MainActor in
            // Resolve all one-shot requests first so overlapping callers share this update.
            if let latest = locs.last {
                self.completeLocationRequests(with: .success(latest))
            } else {
                self.completeLocationRequests(with: .failure(Error.unavailable))
            }
            // Don't return — also forward to significant-change consumers below.
            if let callback = self.significantLocationCallback, let latest = locs.last {
                callback(latest)
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Swift.Error) {
        let err = error
        Task { @MainActor in
            self.completeLocationRequests(with: .failure(err))
        }
    }
}
