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

    @Test func `iOS app on Mac replaces generic iPad node name`() {
        let name = NodeDisplayName.resolve(
            existing: "iPad Node",
            deviceName: "Studio Mac",
            interfaceIdiom: .pad,
            isIOSAppOnMac: true)

        #expect(name == "OpenClaw Mac App")
    }

    @Test func `iOS app on Mac replaces persisted generic iPad device name`() {
        let name = NodeDisplayName.resolve(
            existing: "iPad",
            deviceName: "iPad",
            interfaceIdiom: .pad,
            isIOSAppOnMac: true)

        #expect(name == "OpenClaw Mac App")
    }

    @Test func `iOS app on Mac replaces persisted generic iPhone device name`() {
        let name = NodeDisplayName.resolve(
            existing: "iPhone",
            deviceName: "iPhone",
            interfaceIdiom: .phone,
            isIOSAppOnMac: true)

        #expect(name == "OpenClaw Mac App")
    }

    @Test func `iOS app on Mac preserves a custom node name`() {
        let name = NodeDisplayName.resolve(
            existing: "Studio controller",
            deviceName: "Studio Mac",
            interfaceIdiom: .pad,
            isIOSAppOnMac: true)

        #expect(name == "Studio controller")
    }

    @Test func `physical iPad keeps its device name`() {
        let name = NodeDisplayName.resolve(
            existing: "iPad Node",
            deviceName: "Office iPad",
            interfaceIdiom: .pad,
            isIOSAppOnMac: false)

        #expect(name == "Office iPad")
    }

    @Test func `physical iPad keeps its generic device name`() {
        let name = NodeDisplayName.resolve(
            existing: "iPad",
            deviceName: "iPad",
            interfaceIdiom: .pad,
            isIOSAppOnMac: false)

        #expect(name == "iPad")
    }

    @Test func `physical iPhone replaces stale Mac compatibility default`() {
        let name = NodeDisplayName.resolve(
            existing: "OpenClaw Mac App",
            deviceName: "QA iPhone",
            interfaceIdiom: .phone,
            isIOSAppOnMac: false)

        #expect(name == "QA iPhone")
    }

    @Test func `blank device name falls back to physical device family`() {
        let name = NodeDisplayName.resolve(
            existing: nil,
            deviceName: "",
            interfaceIdiom: .phone,
            isIOSAppOnMac: false)

        #expect(name == "iPhone Node")
    }
}
