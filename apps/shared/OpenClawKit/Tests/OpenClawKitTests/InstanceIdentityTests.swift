import Foundation
import Testing
@testable import OpenClawKit

struct InstanceIdentityTests {
    private let version = OperatingSystemVersion(majorVersion: 26, minorVersion: 5, patchVersion: 0)

    @Test func `iOS app on Mac avoids physical iPad identity`() {
        let metadata = AppleMobileInstanceMetadata.resolve(
            version: self.version,
            interfaceIdiom: .pad,
            isIOSAppOnMac: true,
            rawModelIdentifier: "iPad16,6")

        #expect(metadata.platformString == "iOS 26.5.0")
        #expect(metadata.deviceFamily == "iOS")
        #expect(metadata.modelIdentifier == "Apple Silicon Mac")
    }

    @Test func `physical iPad keeps iPad metadata`() {
        let metadata = AppleMobileInstanceMetadata.resolve(
            version: self.version,
            interfaceIdiom: .pad,
            isIOSAppOnMac: false,
            rawModelIdentifier: " iPad16,6 ")

        #expect(metadata.platformString == "iPadOS 26.5.0")
        #expect(metadata.deviceFamily == "iPad")
        #expect(metadata.modelIdentifier == "iPad16,6")
    }

    @Test func `physical iPhone keeps iPhone metadata`() {
        let metadata = AppleMobileInstanceMetadata.resolve(
            version: self.version,
            interfaceIdiom: .phone,
            isIOSAppOnMac: false,
            rawModelIdentifier: "iPhone17,1")

        #expect(metadata.platformString == "iOS 26.5.0")
        #expect(metadata.deviceFamily == "iPhone")
        #expect(metadata.modelIdentifier == "iPhone17,1")
    }

    @Test func `blank physical model identifier is omitted`() {
        let metadata = AppleMobileInstanceMetadata.resolve(
            version: self.version,
            interfaceIdiom: .other,
            isIOSAppOnMac: false,
            rawModelIdentifier: " \n ")

        #expect(metadata.platformString == "iOS 26.5.0")
        #expect(metadata.deviceFamily == "iOS")
        #expect(metadata.modelIdentifier == nil)
    }
}
