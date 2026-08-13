import CoreLocation
import OpenClawIPC
import Testing
import UserNotifications
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct PermissionManagerTests {
    @Test func `notification authorization accepts provisional delivery`() throws {
        #expect(PermissionManager.isNotificationAuthorized(status: .authorized))
        #expect(PermissionManager.isNotificationAuthorized(status: .provisional))
        #expect(!PermissionManager.isNotificationAuthorized(status: .notDetermined))
        #expect(!PermissionManager.isNotificationAuthorized(status: .denied))
        let ephemeral = try #require(UNAuthorizationStatus(rawValue: 4))
        #expect(!PermissionManager.isNotificationAuthorized(status: ephemeral))
    }

    @Test func `voice wake permission helpers match status`() async {
        let direct = PermissionManager.voiceWakePermissionsGranted()
        let ensured = await PermissionManager.ensureVoiceWakePermissions(interactive: false)
        #expect(ensured == direct)
    }

    @Test func `status can query non interactive caps`() async {
        let caps: [Capability] = [.microphone, .speechRecognition, .screenRecording]
        let status = await PermissionManager.grantedStatus(caps)
        #expect(status.keys.count == caps.count)
    }

    @Test func `ensure non interactive does not throw`() async {
        let caps: [Capability] = [.microphone, .speechRecognition, .screenRecording]
        let ensured = await PermissionManager.ensure(caps, interactive: false)
        #expect(ensured.keys.count == caps.count)
    }

    @Test func `location status matches canonical authorization`() async {
        let status = await PermissionManager.locationAuthorizationStatus()
        let results = await PermissionManager.grantedStatus([.location])
        let expected = CLLocationManager.locationServicesEnabled()
            && PermissionManager.isLocationAuthorized(status: status, requireAlways: false)
        #expect(results[.location] == expected)
    }

    @Test func `ensure location non interactive matches canonical authorization`() async {
        let status = await PermissionManager.locationAuthorizationStatus()
        let ensured = await PermissionManager.ensure([.location], interactive: false)
        let expected = CLLocationManager.locationServicesEnabled()
            && PermissionManager.isLocationAuthorized(status: status, requireAlways: false)
        #expect(ensured[.location] == expected)
    }
}
