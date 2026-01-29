import MoltbotKit
import Foundation
import Testing
import UIKit
@testable import Moltbot

private func withUserDefaults<T>(_ updates: [String: Any?], _ body: () throws -> T) rethrows -> T {
    let defaults = UserDefaults.standard
    var snapshot: [String: Any?] = [:]
    for key in updates.keys {
        snapshot[key] = defaults.object(forKey: key)
    }
    for (key, value) in updates {
        if let value {
            defaults.set(value, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
    defer {
        for (key, value) in snapshot {
            if let value {
                defaults.set(value, forKey: key)
            } else {
                defaults.removeObject(forKey: key)
            }
        }
    }
    return try body()
}

@Suite(.serialized) struct GatewayConnectionControllerTests {
    @Test @MainActor func resolvedDisplayNameSetsDefaultWhenMissing() {
        let defaults = UserDefaults.standard
        let displayKey = "node.displayName"

        withUserDefaults([displayKey: nil, "node.instanceId": "ios-test"]) {
            let appModel = NodeAppModel()
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            let resolved = controller._test_resolvedDisplayName(defaults: defaults)
            #expect(!resolved.isEmpty)
            #expect(defaults.string(forKey: displayKey) == resolved)
        }
    }

    @Test @MainActor func currentCapsReflectToggles() {
        withUserDefaults([
            "node.instanceId": "ios-test",
            "node.displayName": "Test Node",
            "camera.enabled": true,
            "location.enabledMode": MoltbotLocationMode.always.rawValue,
            VoiceWakePreferences.enabledKey: true,
        ]) {
            let appModel = NodeAppModel()
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
            let caps = Set(controller._test_currentCaps())

            #expect(caps.contains(MoltbotCapability.canvas.rawValue))
            #expect(caps.contains(MoltbotCapability.screen.rawValue))
            #expect(caps.contains(MoltbotCapability.camera.rawValue))
            #expect(caps.contains(MoltbotCapability.location.rawValue))
            #expect(caps.contains(MoltbotCapability.voiceWake.rawValue))
        }
    }

    @Test @MainActor func currentCommandsIncludeLocationWhenEnabled() {
        withUserDefaults([
            "node.instanceId": "ios-test",
            "location.enabledMode": MoltbotLocationMode.whileUsing.rawValue,
        ]) {
            let appModel = NodeAppModel()
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
            let commands = Set(controller._test_currentCommands())

            #expect(commands.contains(MoltbotLocationCommand.get.rawValue))
        }
    }

    @Test @MainActor func currentCommandsMatchGatewayIOSAllowlist() {
        // Verify only iOS-allowlisted commands are declared.
        // iOS allowlist per node-command-policy.ts: canvas, camera, screen, location
        // System commands (run, which, notify, execApprovals.*) are NOT allowed on iOS.
        withUserDefaults([
            "node.instanceId": "ios-test",
            "camera.enabled": true,
            "location.enabledMode": MoltbotLocationMode.whileUsing.rawValue,
        ]) {
            let appModel = NodeAppModel()
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
            let commands = Set(controller._test_currentCommands())

            #expect(commands.contains(MoltbotCanvasCommand.present.rawValue))
            #expect(commands.contains(MoltbotCanvasCommand.hide.rawValue))
            #expect(commands.contains(MoltbotCanvasCommand.navigate.rawValue))
            #expect(commands.contains(MoltbotCanvasCommand.evalJS.rawValue))
            #expect(commands.contains(MoltbotCanvasCommand.snapshot.rawValue))
            #expect(commands.contains(MoltbotCanvasA2UICommand.push.rawValue))
            #expect(commands.contains(MoltbotCanvasA2UICommand.pushJSONL.rawValue))
            #expect(commands.contains(MoltbotCanvasA2UICommand.reset.rawValue))
            #expect(commands.contains(MoltbotScreenCommand.record.rawValue))
            #expect(commands.contains(MoltbotCameraCommand.list.rawValue))
            #expect(commands.contains(MoltbotCameraCommand.snap.rawValue))
            #expect(commands.contains(MoltbotCameraCommand.clip.rawValue))
            #expect(commands.contains(MoltbotLocationCommand.get.rawValue))

            #expect(!commands.contains(MoltbotSystemCommand.notify.rawValue))
            #expect(!commands.contains(MoltbotSystemCommand.which.rawValue))
            #expect(!commands.contains(MoltbotSystemCommand.run.rawValue))
            #expect(!commands.contains(MoltbotSystemCommand.execApprovalsGet.rawValue))
            #expect(!commands.contains(MoltbotSystemCommand.execApprovalsSet.rawValue))
        }
    }
}
