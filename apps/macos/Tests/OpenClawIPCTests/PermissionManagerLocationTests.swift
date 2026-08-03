import CoreLocation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct PermissionManagerLocationTests {
    @Test
    func `concurrent request waiters all resume`() async {
        let coordinator = LocationPermissionRequestCoordinator()
        let first = Task { @MainActor in
            await coordinator.wait { _ in }
        }
        while coordinator.pendingRequestCount < 1 {
            await Task.yield()
        }

        let second = Task { @MainActor in
            await coordinator.wait { _ in }
        }
        while coordinator.pendingRequestCount < 2 {
            await Task.yield()
        }

        coordinator.finish(status: .denied)

        #expect(await first.value == .denied)
        #expect(await second.value == .denied)
        #expect(coordinator.pendingRequestCount == 0)
    }

    @Test
    func `authorizedAlways counts for both modes`() {
        #expect(PermissionManager.isLocationAuthorized(status: .authorizedAlways, requireAlways: false))
        #expect(PermissionManager.isLocationAuthorized(status: .authorizedAlways, requireAlways: true))
    }

    @Test
    func `other statuses not authorized`() {
        #expect(!PermissionManager.isLocationAuthorized(status: .notDetermined, requireAlways: false))
        #expect(!PermissionManager.isLocationAuthorized(status: .denied, requireAlways: false))
        #expect(!PermissionManager.isLocationAuthorized(status: .restricted, requireAlways: false))
    }
}
