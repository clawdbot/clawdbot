import AppIntents
import Foundation
import OpenClawKit
import Testing
import UIKit
@testable import OpenClaw

@Suite(.serialized) struct OpenClawAppDelegateTests {
    @Test func `live voice description is available to App Intents consumers`() {
        let intentType: any AppIntent.Type = StartLiveVoiceIntent.self
        #expect(intentType.description != nil)
    }

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

    @Test func `live voice intent exposes its description through the AppIntent protocol`() {
        let intent: any AppIntent.Type = StartLiveVoiceIntent.self
        #expect(intent.description != nil)
    }

    @Test @MainActor func `live voice intent survives cold launch and waits for an active scene`() async throws {
        try await withUserDefaults(["talk.enabled": false]) {
            let previousModel = OpenClawAppModelRegistry.appModel
            OpenClawAppModelRegistry.appModel = nil
            defer { OpenClawAppModelRegistry.appModel = previousModel }

            _ = try await StartLiveVoiceIntent().perform()
            _ = try await StartLiveVoiceIntent().perform()
            let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
            defer { model.setTalkEnabled(false) }
            OpenClawAppModelRegistry.appModel = model
            model.focusChatSession("agent:main:shortcut-test")

            model.consumeLiveVoiceStartRequest(
                isSceneActive: false, isOnboardingPresented: false, hasGatewayConfiguration: true)
            #expect(model.pendingLiveVoiceStart)
            #expect(!model.talkMode.isEnabled)
            #expect(model.openChatRequestID == 0)

            model.consumeLiveVoiceStartRequest(
                isSceneActive: true, isOnboardingPresented: false, hasGatewayConfiguration: true)
            #expect(!model.pendingLiveVoiceStart)
            #expect(model.talkMode.isEnabled)
            #expect(model.chatSessionKey == "agent:main:shortcut-test")
            #expect(model.talkMode.isUsingMainSessionKey("agent:main:shortcut-test"))
            let requestID = model.openChatRequestID
            #expect(model.consumeOpenChatRequest(requestID))
            #expect(!model.consumeOpenChatRequest(requestID))

            model.consumeLiveVoiceStartRequest(
                isSceneActive: true, isOnboardingPresented: false, hasGatewayConfiguration: true)
            #expect(model.openChatRequestID == requestID)
            let replacement = NodeAppModel(audioAdmissionInitiallyAllowed: false)
            defer { replacement.setTalkEnabled(false) }
            OpenClawAppModelRegistry.appModel = replacement
            #expect(!replacement.pendingLiveVoiceStart)
        }
    }

    @Test @MainActor
    func `warm live voice intent opens the selected chat without toggling existing voice`() async throws {
        try await withUserDefaults(["talk.enabled": false]) {
            let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
            let previousModel = OpenClawAppModelRegistry.appModel
            OpenClawAppModelRegistry.appModel = model
            defer {
                model.setTalkEnabled(false)
                OpenClawAppModelRegistry.appModel = previousModel
            }
            model.focusChatSession("agent:main:voice-session")
            model.setTalkEnabled(true)
            model.talkMode.statusText = "Existing conversation"

            for _ in 0..<2 {
                _ = try await StartLiveVoiceIntent().perform()
                model.consumeLiveVoiceStartRequest(
                    isSceneActive: true, isOnboardingPresented: false, hasGatewayConfiguration: true)
                #expect(model.talkMode.isEnabled)
                #expect(model.talkMode.statusText == "Existing conversation")
                #expect(model.chatSessionKey == "agent:main:voice-session")
                #expect(model.consumeOpenChatRequest(model.openChatRequestID))
                #expect(model.liveVoiceStartError == nil)
            }
        }
    }

    @Test(arguments: [true, false]) @MainActor
    func `live voice request is rejected rather than replayed after setup`(isOnboardingPresented: Bool) {
        withUserDefaults(["talk.enabled": false]) {
            let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
            defer { model.setTalkEnabled(false) }
            model.requestLiveVoiceStart()
            model.consumeLiveVoiceStartRequest(
                isSceneActive: true,
                isOnboardingPresented: isOnboardingPresented,
                hasGatewayConfiguration: isOnboardingPresented)

            #expect(!model.pendingLiveVoiceStart)
            #expect(!model.talkMode.isEnabled)
            #expect(model.liveVoiceStartError?.contains("Connect to your Gateway") == true)
            model.consumeLiveVoiceStartRequest(
                isSceneActive: true, isOnboardingPresented: false, hasGatewayConfiguration: true)
            #expect(!model.talkMode.isEnabled)
            #expect(model.openChatRequestID == 0)
        }
    }

    @Test @MainActor func `live voice surfaces the canonical capture rejection`() {
        withUserDefaults(["talk.enabled": false, "talk.background.enabled": false]) {
            let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
            defer { model.setTalkEnabled(false) }
            model.enterAppleReviewDemoMode()
            model.requestLiveVoiceStart()
            model.consumeLiveVoiceStartRequest(
                isSceneActive: true, isOnboardingPresented: false, hasGatewayConfiguration: true)

            #expect(!model.pendingLiveVoiceStart)
            #expect(!model.talkMode.isEnabled)
            #expect(model.liveVoiceStartError == "Demo mode only")
            #expect(model.consumeOpenChatRequest(model.openChatRequestID))
        }
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
