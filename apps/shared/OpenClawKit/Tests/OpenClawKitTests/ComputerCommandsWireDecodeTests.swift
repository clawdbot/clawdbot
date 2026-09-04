import Foundation
import OpenClawKit
import Testing

struct ComputerCommandsWireDecodeTests {
    private struct DecodeCase {
        let json: String
        let action: OpenClawComputerAction
        var app: String?
        var windowRef: String?
        var elementRef: String?
        var observationId: String?
        var deliveryMode: OpenClawComputerDeliveryMode?
        var query: String?
        var depth: Int?
        var maxElements: Int?
        var value: String?
        var path: [String]?
        var x: Double?
        var y: Double?
        var text: String?
        var keys: String?
    }

    private func decode(_ testCase: DecodeCase) throws -> OpenClawComputerActParams {
        try JSONDecoder().decode(OpenClawComputerActParams.self, from: Data(testCase.json.utf8))
    }

    private func expectFields(_ params: OpenClawComputerActParams, match testCase: DecodeCase) {
        #expect(params.action == testCase.action)
        #expect(params.app == testCase.app)
        #expect(params.windowRef == testCase.windowRef)
        #expect(params.elementRef == testCase.elementRef)
        #expect(params.observationId == testCase.observationId)
        #expect(params.deliveryMode == testCase.deliveryMode)
        #expect(params.query == testCase.query)
        #expect(params.depth == testCase.depth)
        #expect(params.maxElements == testCase.maxElements)
        #expect(params.value == testCase.value)
        #expect(params.path == testCase.path)
        #expect(params.x == testCase.x)
        #expect(params.y == testCase.y)
        #expect(params.text == testCase.text)
        #expect(params.keys == testCase.keys)
    }

    @Test func `decodes every implemented v2 action family and delivery mode`() throws {
        let cases = [
            DecodeCase(
                json: #"""
                {"action":"get_accessibility_tree","windowRef":"window-1","query":"Save",
                 "depth":4,"maxElements":250}
                """#,
                action: .getAccessibilityTree,
                windowRef: "window-1",
                query: "Save",
                depth: 4,
                maxElements: 250),
            DecodeCase(
                json: #"""
                {"action":"get_window_state","windowRef":"window-2","observationId":"observation-2",
                 "deliveryMode":"background"}
                """#,
                action: .getWindowState,
                windowRef: "window-2",
                observationId: "observation-2",
                deliveryMode: .background),
            DecodeCase(
                json: #"{"action":"launch_app","app":"TextEdit","deliveryMode":"foreground"}"#,
                action: .launchApp,
                app: "TextEdit",
                deliveryMode: .foreground),
            DecodeCase(
                json: #"""
                {"action":"set_value","elementRef":"element-3","observationId":"observation-3",
                 "value":"hello","deliveryMode":"background"}
                """#,
                action: .setValue,
                elementRef: "element-3",
                observationId: "observation-3",
                deliveryMode: .background,
                value: "hello"),
            DecodeCase(
                json: #"{"action":"invoke_menu","app":"app-4","path":["File","Save As…"],"deliveryMode":"foreground"}"#,
                action: .invokeMenu,
                app: "app-4",
                deliveryMode: .foreground,
                path: ["File", "Save As…"]),
            DecodeCase(
                json: #"""
                {"action":"left_click","windowRef":"window-5","observationId":"observation-5",
                 "x":120,"y":240,"deliveryMode":"background"}
                """#,
                action: .leftClick,
                windowRef: "window-5",
                observationId: "observation-5",
                deliveryMode: .background,
                x: 120,
                y: 240),
            DecodeCase(
                json: #"{"action":"type","windowRef":"window-6","text":"hello","deliveryMode":"foreground"}"#,
                action: .type,
                windowRef: "window-6",
                deliveryMode: .foreground,
                text: "hello"),
            DecodeCase(
                json: #"{"action":"key","elementRef":"element-7","keys":"cmd+return","deliveryMode":"background"}"#,
                action: .key,
                elementRef: "element-7",
                deliveryMode: .background,
                keys: "cmd+return"),
        ]

        for testCase in cases {
            try self.expectFields(self.decode(testCase), match: testCase)
        }
    }

    @Test func `rejects unknown and native-unimplemented action names`() throws {
        for action in ["totally_unknown", "browser_click", "start_recording"] {
            let data = Data(#"{"action":"\#(action)"}"#.utf8)
            #expect(throws: DecodingError.self) {
                _ = try JSONDecoder().decode(OpenClawComputerActParams.self, from: data)
            }
        }
    }

    @Test func `managed close decodes separately and actions retain execution ownership`() throws {
        let id = try #require(UUID(uuidString: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
        for action in ["left_mouse_down", "__close_execution"] {
            let data = Data(
                #"{"action":"\#(action)","executionId":"\#(id.uuidString.lowercased())","reason":"completed"}"#
                    .utf8)
            let invocation = try JSONDecoder().decode(OpenClawComputerActInvocation.self, from: data)
            switch invocation {
            case let .close(decoded), let .action(decoded): #expect(decoded == id)
            }
        }
        let ordinary = Data(#"{"action":"left_mouse_down","executionId":"\#(id.uuidString)"}"#.utf8)
        #expect(try JSONDecoder().decode(OpenClawComputerActParams.self, from: ordinary).executionId == id)
        #expect(!OpenClawComputerAction.allCases.contains { $0.rawValue == "__close_execution" })
    }

    @Test func `managed close enforces the existing closed bounded worker envelope`() throws {
        let fields = [
            "action": "__close_execution",
            "executionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "reason": "completed",
        ]
        for (key, value) in [
            ("reason", nil), ("reason", ""), ("reason", String(repeating: "x", count: 65)),
            ("extra", "ignored"), ("executionId", nil), ("executionId", "invalid"),
            ("executionId", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"),
            ("executionId", "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"),
        ] as [(String, String?)] {
            var invalid = fields
            invalid[key] = value
            let data = try JSONEncoder().encode(invalid)
            #expect(throws: DecodingError.self) {
                _ = try JSONDecoder().decode(OpenClawComputerActInvocation.self, from: data)
            }
        }
        var boundary = fields
        boundary["reason"] = String(repeating: "\u{1F99E}", count: 64)
        _ = try JSONDecoder().decode(OpenClawComputerActInvocation.self, from: JSONEncoder().encode(boundary))
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(
                OpenClawComputerActInvocation.self, from: Data(#"{"action":"left_mouse_down"}"#.utf8))
        }
    }

    @Test func `action raw values match the frozen computer use v2 contract`() {
        let frozenActionNames = [
            "screenshot", "left_click", "right_click", "middle_click", "double_click",
            "triple_click", "mouse_move", "left_click_drag", "left_mouse_down", "left_mouse_up",
            "scroll", "type", "key", "hold_key", "wait", "list_apps", "list_windows",
            "get_accessibility_tree", "get_cursor_position", "get_window_state", "launch_app",
            "kill_app", "bring_to_front", "set_value", "zoom", "get_browser_state",
            "browser_prepare", "browser_navigate", "browser_click", "browser_type",
            "browser_dialog", "browser_set_input_files", "browser_download", "browser_pointer",
            "escalate_scope", "get_recording_state", "start_recording", "stop_recording",
            "replay_trajectory", "invoke_menu",
        ]

        #expect(OpenClawComputerAction.allCases.map(\.rawValue) == frozenActionNames)
    }
}
