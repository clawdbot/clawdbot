import CoreLocation
import Foundation
import OpenClawKit

/// Monitors significant location changes and pushes `location.update`
/// events to the gateway so the severance hook can determine whether
/// the user is at their configured work location.
@MainActor
enum SignificantLocationMonitor {
    static func startIfNeeded(
        locationService: any LocationServicing,
        locationMode: OpenClawLocationMode,
        gateway: GatewayNodeSession,
        beforeSend: (@MainActor @Sendable () async -> Void)? = nil)
    {
        guard locationMode == .always else { return }
        let status = locationService.authorizationStatus()
        guard status == .authorizedAlways else { return }
        locationService.startMonitoringSignificantLocationChanges { location in
            struct Payload: Codable {
                var lat: Double
                var lon: Double
                var accuracyMeters: Double
                var source: String?
            }
            let payload = Payload(
                lat: location.coordinate.latitude,
                lon: location.coordinate.longitude,
                accuracyMeters: location.horizontalAccuracy,
                source: "ios-significant-location")
            guard let data = try? JSONEncoder().encode(payload),
                  let json = String(data: data, encoding: .utf8)
            else { return }
            Task { @MainActor in
                if let beforeSend {
                    await beforeSend()
                }
                await gateway.sendEvent(event: "location.update", payloadJSON: json)
            }
        }
    }
}
