import Foundation
import OpenClawKit
import Testing
import UIKit
@testable import OpenClaw

@Suite(.serialized) struct OpenClawAppDelegateTests {
    @Test @MainActor func `resolves registry model before view task assigns delegate model`() {
        let registryModel = NodeAppModel()
        OpenClawAppModelRegistry.appModel = registryModel
        defer { OpenClawAppModelRegistry.appModel = nil }

        let delegate = OpenClawAppDelegate()

        #expect(delegate._test_resolvedAppModel() === registryModel)
    }

    @Test @MainActor func `prefers explicit delegate model over registry fallback`() {
        let registryModel = NodeAppModel()
        let explicitModel = NodeAppModel()
        OpenClawAppModelRegistry.appModel = registryModel
        defer { OpenClawAppModelRegistry.appModel = nil }

        let delegate = OpenClawAppDelegate()
        delegate.appModel = explicitModel

        #expect(delegate._test_resolvedAppModel() === explicitModel)
    }

    @Test @MainActor func `background refresh task is permitted and launchable from the app bundle`() throws {
        // BGTaskScheduler rejects submit with .notPermitted unless the identifier is listed
        // and the `fetch` background mode is declared; both contracts live in the app Info.plist.
        let delegate = OpenClawAppDelegate()
        let bundleIdentifier = try #require(Bundle.main.bundleIdentifier)
        let info = try #require(Bundle.main.infoDictionary)
        let identifier = delegate._test_wakeRefreshTaskIdentifier()

        #expect(identifier == "\(bundleIdentifier).bgrefresh")
        #expect(info["BGTaskSchedulerPermittedIdentifiers"] as? [String] == [identifier])
        #expect((info["UIBackgroundModes"] as? [String])?.contains("fetch") == true)
    }

    @Test @MainActor func `stages a gateway URL when the model is ready`() async throws {
        OpenClawAppModelRegistry.appModel = nil
        defer { OpenClawAppModelRegistry.appModel = nil }
        let model = NodeAppModel()
        let delegate = OpenClawAppDelegate()
        delegate.appModel = model
        let url = try #require(URL(
            string: "openclaw://gateway?host=gateway.example.com&port=443&tls=1&token=tok"))

        #expect(delegate.application(UIApplication.shared, open: url))
        let link = await Self.waitForGatewaySetup(in: model)

        #expect(link?.host == "gateway.example.com")
        #expect(link?.port == 443)
        #expect(link?.tls == true)
        #expect(link?.token == "tok")
    }

    @Test @MainActor func `replays a gateway URL received before the model is ready`() async throws {
        OpenClawAppModelRegistry.appModel = nil
        defer { OpenClawAppModelRegistry.appModel = nil }
        let delegate = OpenClawAppDelegate()
        let url = try #require(URL(
            string: "openclaw://gateway?host=gateway.example.com&port=443&tls=1&token=tok"))

        #expect(delegate.application(UIApplication.shared, open: url))

        let model = NodeAppModel()
        delegate.appModel = model
        let link = await Self.waitForGatewaySetup(in: model)

        #expect(link?.host == "gateway.example.com")
        #expect(link?.token == "tok")
    }

    @Test @MainActor func `rejects an invalid URL`() throws {
        let delegate = OpenClawAppDelegate()
        let url = try #require(URL(string: "https://example.com/gateway"))

        #expect(!delegate.application(UIApplication.shared, open: url))
    }

    @MainActor
    private static func waitForGatewaySetup(in model: NodeAppModel) async -> GatewayConnectDeepLink? {
        for _ in 0..<20 {
            if model.gatewaySetupRequestID > 0 {
                return model.consumePendingGatewaySetupLink()
            }
            await Task.yield()
        }
        return nil
    }
}
