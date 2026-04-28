import CoreLocation
import Foundation

@MainActor
public protocol LocationServiceCommon: AnyObject, CLLocationManagerDelegate {
    var locationManager: CLLocationManager { get }
    var locationRequestContinuation: CheckedContinuation<CLLocation, Error>? { get set }
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

    public func requestLocationOnce() async throws -> CLLocation {
        try await LocationServiceSupport.requestLocation(manager: self.locationManager) { continuation in
            self.locationRequestContinuation = continuation
        }
    }
}

public enum LocationServiceSupport {
    public static func accuracyAuthorization(manager: CLLocationManager) -> CLAccuracyAuthorization {
        if #available(iOS 14.0, macOS 11.0, *) {
            return manager.accuracyAuthorization
        }
        return .fullAccuracy
    }

    @MainActor
    public static func requestLocation(
        manager: CLLocationManager,
        setContinuation: @escaping (CheckedContinuation<CLLocation, Error>) -> Void) async throws -> CLLocation
    {
        try await withCheckedThrowingContinuation { continuation in
            setContinuation(continuation)
            manager.requestLocation()
        }
    }
}
