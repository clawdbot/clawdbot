import CoreLocation
import Testing

@testable import Moltbot

@Suite("PermissionManager Location")
struct PermissionManagerLocationTests {
    @Test("authorizedAlways counts for both modes")
    func authorizedAlwaysCountsForBothModes() {
        #expect(PermissionManager.isLocationAuthorized(status: .authorizedAlways, requireAlways: false))
        #expect(PermissionManager.isLocationAuthorized(status: .authorizedAlways, requireAlways: true))
    }

    @Test("other statuses not authorized")
    func otherStatusesNotAuthorized() {
        #expect(!PermissionManager.isLocationAuthorized(status: .notDetermined, requireAlways: false))
        #expect(!PermissionManager.isLocationAuthorized(status: .denied, requireAlways: false))
        #expect(!PermissionManager.isLocationAuthorized(status: .restricted, requireAlways: false))
    }
}
