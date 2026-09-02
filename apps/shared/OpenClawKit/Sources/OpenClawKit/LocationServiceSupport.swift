import CoreLocation
import Foundation

@MainActor
public protocol LocationServiceCommon: AnyObject, CLLocationManagerDelegate {
    var locationManager: CLLocationManager { get }
    var locationRequestContinuation: CheckedContinuation<CLLocation, Error>? { get set }
}

@MainActor
public protocol ConcurrentLocationServiceCommon: LocationServiceCommon, Sendable {
    var locationRequestContinuations: [UUID: CheckedContinuation<CLLocation, Error>] { get set }
}

extension LocationServiceCommon {
    public func configureLocationManager() {
        self.locationManager.delegate = self
        self.locationManager.desiredAccuracy = kCLLocationAccuracyBest
    }

    public func authorizationStatus() -> CLAuthorizationStatus {
        self.locationManager.authorizationStatus
    }

    public func accuracyAuthorization() -> CLAccuracyAuthorization {
        LocationServiceSupport.accuracyAuthorization(manager: self.locationManager)
    }
}

extension ConcurrentLocationServiceCommon {
    public func requestLocationOnce() async throws -> CLLocation {
        // CLLocationManager coalesces requestLocation calls into one pending fix, so every
        // active waiter shares the next delegate result; cancel the platform request only last.
        let requestID = UUID()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await LocationServiceSupport.requestLocation(manager: self.locationManager) { continuation in
                self.locationRequestContinuations[requestID] = continuation
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                guard let self,
                      let continuation = self.locationRequestContinuations.removeValue(forKey: requestID)
                else {
                    return
                }
                if self.locationRequestContinuations.isEmpty,
                   self.locationRequestContinuation == nil
                {
                    self.locationManager.stopUpdatingLocation()
                }
                continuation.resume(throwing: CancellationError())
            }
        }
    }
}

enum LocationServiceSupport {
    static func accuracyAuthorization(manager: CLLocationManager) -> CLAccuracyAuthorization {
        if #available(iOS 14.0, macOS 11.0, *) {
            return manager.accuracyAuthorization
        }
        return .fullAccuracy
    }

    @MainActor
    static func requestLocation(
        manager: CLLocationManager,
        setContinuation: @escaping (CheckedContinuation<CLLocation, Error>) -> Void) async throws -> CLLocation
    {
        try await withCheckedThrowingContinuation { continuation in
            guard !Task.isCancelled else {
                continuation.resume(throwing: CancellationError())
                return
            }
            setContinuation(continuation)
            manager.requestLocation()
        }
    }
}
