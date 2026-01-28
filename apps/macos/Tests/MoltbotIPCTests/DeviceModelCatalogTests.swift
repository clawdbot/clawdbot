import Testing
@testable import Moltbot

@Suite
struct DeviceModelCatalogTests {
    @Test
    func symbolPrefersModelIdentifierPrefixes() {
        #expect(DeviceModelCatalog
            .symbol(deviceFamily: "iPad", modelIdentifier: "iPad16,6", friendlyName: nil) == "ipad")
        #expect(DeviceModelCatalog
            .symbol(deviceFamily: "iPhone", modelIdentifier: "iPhone17,3", friendlyName: nil) == "iphone")
    }

    @Test
    func symbolUsesFriendlyNameForMacVariants() {
        #expect(DeviceModelCatalog.symbol(
            deviceFamily: "Mac",
            modelIdentifier: "Mac99,1",
            friendlyName: "Mac Studio (2025)") == "macstudio")
        #expect(DeviceModelCatalog.symbol(
            deviceFamily: "Mac",
            modelIdentifier: "Mac99,2",
            friendlyName: "Mac mini (2024)") == "macmini")
        #expect(DeviceModelCatalog.symbol(
            deviceFamily: "Mac",
            modelIdentifier: "Mac99,3",
            friendlyName: "MacBook Pro (14-inch, 2024)") == "laptopcomputer")
    }

    @Test
    func symbolFallsBackToDeviceFamily() {
        #expect(DeviceModelCatalog.symbol(deviceFamily: "Android", modelIdentifier: "", friendlyName: nil) == "android")
        #expect(DeviceModelCatalog.symbol(deviceFamily: "Linux", modelIdentifier: "", friendlyName: nil) == "cpu")
    }

    @Test
    func presentationUsesBundledModelMappings() {
        let presentation = DeviceModelCatalog.presentation(deviceFamily: "iPhone", modelIdentifier: "iPhone1,1")
        #expect(presentation?.title == "iPhone")
    }
}
