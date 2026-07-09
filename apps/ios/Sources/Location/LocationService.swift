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
    private var authWaitID: UUID?
    private var authWaitRequiresDeterminedStatus = false
    private var authContinuation: CheckedContinuation<CLAuthorizationStatus, Never>?
    private var locationContinuation: CheckedContinuation<CLLocation, Swift.Error>?
    var locationRequestContinuations: [UUID: CheckedContinuation<CLLocation, Swift.Error>] = [:]
    private var authorizationChangeHandler: (@MainActor @Sendable (CLAuthorizationStatus) -> Void)?
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

    func ensureAuthorization(mode: OpenClawLocationMode) async -> CLAuthorizationStatus {
        guard CLLocationManager.locationServicesEnabled() else { return .denied }

        let status = self.manager.authorizationStatus
        if status == .notDetermined {
            let updated = await self.requestAuthorization(requiresDeterminedStatus: true) {
                self.manager.requestWhenInUseAuthorization()
            }
            if mode != .always { return updated }
        }

        if mode == .always {
            let current = self.manager.authorizationStatus
            if current == .authorizedWhenInUse {
                return await self.requestAuthorization(requiresDeterminedStatus: false) {
                    self.manager.requestAlwaysAuthorization()
                }
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

    private func requestAuthorization(
        requiresDeterminedStatus: Bool,
        request: () -> Void) async -> CLAuthorizationStatus
    {
        await withCheckedContinuation { cont in
            let waitID = UUID()
            self.authWaitID = waitID
            self.authWaitRequiresDeterminedStatus = requiresDeterminedStatus
            self.authContinuation = cont
            // Install the waiter before requesting permission so a fast delegate callback cannot be lost.
            request()
            Task { @MainActor in
                let clock = ContinuousClock()
                let noPromptDeadline = clock.now.advanced(by: .milliseconds(1500))
                var activeUndeterminedDeadline: ContinuousClock.Instant?
                var observedPrompt = UIApplication.shared.applicationState != .active
                // A slow system prompt must not trigger the no-callback fallback. Once iOS makes
                // the app inactive, wait until the user dismisses the prompt and the app returns.
                while self.authWaitID == waitID, self.authContinuation != nil {
                    try? await Task.sleep(for: .milliseconds(100))
                    let applicationIsActive = UIApplication.shared.applicationState == .active
                    if !applicationIsActive {
                        observedPrompt = true
                        activeUndeterminedDeadline = nil
                        continue
                    }
                    guard observedPrompt || clock.now >= noPromptDeadline else { continue }
                    let status = self.manager.authorizationStatus
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
        guard self.authWaitID == waitID, let cont = self.authContinuation else { return }
        guard Self.shouldCompleteAuthorizationWait(
            status: status,
            requiresDeterminedStatus: self.authWaitRequiresDeterminedStatus,
            allowUndeterminedFallback: allowUndeterminedFallback)
        else { return }
        self.authWaitID = nil
        self.authWaitRequiresDeterminedStatus = false
        self.authContinuation = nil
        cont.resume(returning: status)
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
        _ handler: @escaping @MainActor @Sendable (CLAuthorizationStatus) -> Void)
    {
        self.authorizationChangeHandler = handler
    }

    func stopMonitoringSignificantLocationChanges() {
        self.significantLocationCallback = nil
        self.isMonitoringSignificantChanges = false
        self.manager.stopMonitoringSignificantLocationChanges()
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            self.authorizationChangeHandler?(status)
            guard let waitID = self.authWaitID else { return }
            self.finishAuthorizationWait(waitID: waitID, status: status)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let locs = locations
        Task { @MainActor in
            // Resolve all one-shot requests first so overlapping callers share this update.
            let continuations = Array(self.locationRequestContinuations.values) + [self.locationContinuation]
                .compactMap(\.self)
            self.locationRequestContinuations.removeAll()
            self.locationContinuation = nil
            for continuation in continuations {
                if let latest = locs.last {
                    continuation.resume(returning: latest)
                } else {
                    continuation.resume(throwing: Error.unavailable)
                }
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
            let continuations = Array(self.locationRequestContinuations.values) + [self.locationContinuation]
                .compactMap(\.self)
            self.locationRequestContinuations.removeAll()
            self.locationContinuation = nil
            for continuation in continuations {
                continuation.resume(throwing: err)
            }
        }
    }
}
