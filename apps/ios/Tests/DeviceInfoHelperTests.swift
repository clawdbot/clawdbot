import Foundation
import Testing
@testable import OpenClaw

struct DeviceInfoHelperTests {
    @Test func `iOS version display omits platform prefix`() {
        let version = OperatingSystemVersion(majorVersion: 26, minorVersion: 5, patchVersion: 0)

        #expect(DeviceInfoHelper.iOSVersionStringForDisplay(version) == "26.5.0")
    }

    @Test func `build metadata prefers canonical iOS version`() {
        let metadata = DeviceInfoHelper.buildMetadata(infoDictionary: [
            "OpenClawCanonicalVersion": "2026.7.10",
            "CFBundleShortVersionString": "2026.7.9",
            "CFBundleVersion": "42",
        ])

        #expect(metadata.versionDisplay == "2026.7.10 (42)")
    }
}
