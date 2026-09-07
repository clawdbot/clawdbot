
extension OpenClawSnapshotUITests {
    private static var f26Notice: String {
        "Could not refresh models. Previous choices are unchanged. Refresh to retry."
    }

    private struct F26Case: Decodable {
        let label: String
        let state: String
    }

    private struct F26Read: Decodable {
        let sessionKey: String
    }

    private struct F26Connection: Decodable {
        let role: String?
        let latest: F26Read?
    }

    private struct F26Status: Decodable {
        let ready: Bool
        let uncertain: Bool
        let cases: [F26Case]
        let connections: [F26Connection]
    }

    private func f26Control(_ operation: String, body: [String: String]? = nil) async throws -> F26Status {
        let environment = ProcessInfo.processInfo.environment
        let endpoint = try XCTUnwrap(environment["OPENCLAW_F26_CONTROL_URL"].flatMap(URL.init(string:)))
        XCTAssertEqual(endpoint.host, "127.0.0.1")
        XCTAssertEqual(endpoint.port, 19763)
        let token = try XCTUnwrap(environment["OPENCLAW_F26_CONTROL_TOKEN"])
        var request = URLRequest(url: endpoint.appendingPathComponent(operation))
        request.timeoutInterval = 20
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, "F26 control refused; preserve wire evidence")
        let status = try JSONDecoder().decode(F26Status.self, from: data)
        XCTAssertTrue(status.ready)
        XCTAssertFalse(status.uncertain)
        return status
    }

    private func f26Wait(_ label: String, state: String) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(10))
        while clock.now < deadline {
            let status = try await self.f26Control("status")
            if status.cases.contains(where: { $0.label == label && $0.state == state }) { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTFail("F26 case did not reach \(state); no automatic retry")
    }

    private func f26Capture(_ name: String, in app: XCUIApplication) {
        self.attachScreenshot(named: name)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = name + "-hierarchy"
        hierarchy.lifetime = .keepAlways
        self.add(hierarchy)
    }

    private func f26CheckChoices(in app: XCUIApplication) {
        let picker = app.buttons["chat-composer-inline-model"]
        XCTAssertTrue(picker.waitForExistence(timeout: 8))
        picker.tap()
        let alpha = app.buttons["f26/alpha"]
        let beta = app.buttons["f26/beta"]
        XCTAssertTrue(alpha.waitForExistence(timeout: 5))
        XCTAssertTrue(beta.exists)
        XCTAssertTrue(alpha.isEnabled)
        XCTAssertTrue(beta.isEnabled)
        self.f26Capture("f26-retained-picker", in: app)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5)).tap()
    }

    func testF26CurrentReadNoticeAndRefreshRecovery() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["OPENCLAW_F26_PROOF"] == "1")
        let app = try self.launchPairedLiveGatewayApp(initialTab: "chat", initialDestination: "chat")
        self.f26CheckChoices(in: app)
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap()
        input.typeText("Unsent F26 draft")
        self.f26Capture("f26-before-current-failure", in: app)
        let label = "current-" + UUID().uuidString.lowercased()
        _ = try await self.f26Control("case", body: ["label": label, "mode": "reject", "trigger": "publication", "sessionKey": "agent:main:main"])
        try await self.f26Wait(label, state: "written")
        let notice = app.staticTexts[Self.f26Notice]
        let appeared = notice.waitForExistence(timeout: 5)
        self.f26Capture("f26-current-failure-outcome", in: app)
        self.f26CheckChoices(in: app)
        XCTAssertEqual(input.value as? String, "Unsent F26 draft")
        XCTAssertTrue(appeared, "Current failed model read must retain choices and show a retry notice")

        let refreshLabel = "refresh-" + UUID().uuidString.lowercased()
        _ = try await self.f26Control("case", body: ["label": refreshLabel, "mode": "reject", "trigger": "refresh", "sessionKey": "agent:main:main"])
        let refresh = app.buttons["Refresh"].firstMatch
        XCTAssertTrue(refresh.waitForExistence(timeout: 5))
        refresh.tap()
        try await self.f26Wait(refreshLabel, state: "written")
        XCTAssertTrue(notice.waitForExistence(timeout: 8), "Bootstrap completion must not erase this read failure")
        self.f26Capture("f26-refresh-failure-outcome", in: app)
        XCTAssertEqual(input.value as? String, "Unsent F26 draft")

        let recoveryLabel = "recovery-" + UUID().uuidString.lowercased()
        _ = try await self.f26Control("case", body: ["label": recoveryLabel, "mode": "pass", "trigger": "publication", "sessionKey": "agent:main:main"])
        try await self.f26Wait(recoveryLabel, state: "written")
        XCTAssertTrue(notice.waitForNonExistence(timeout: 5))
        self.f26CheckChoices(in: app)
        XCTAssertEqual(input.value as? String, "Unsent F26 draft")
        self.f26Capture("f26-current-recovered", in: app)
    }

    func testF26LateOldSessionFailureDoesNotEnterNewChat() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["OPENCLAW_F26_PROOF"] == "1")
        let app = try self.launchPairedLiveGatewayApp(initialTab: "chat", initialDestination: "chat")
        self.f26CheckChoices(in: app)
        XCTAssertTrue(app.staticTexts["Synthetic F26 history. No inference was requested."].waitForExistence(timeout: 5))
        let label = "old-session-" + UUID().uuidString.lowercased()
        _ = try await self.f26Control("case", body: ["label": label, "mode": "hold-reject", "trigger": "publication", "sessionKey": "agent:main:main"])
        try await self.f26Wait(label, state: "held")
        try self.startNewChatFromSidebar()
        self.f26CheckChoices(in: app)
        XCTAssertTrue(app.staticTexts["What would you like to work on?"].waitForExistence(timeout: 5))
        let status = try await self.f26Control("status")
        let reads = status.connections.filter { $0.role == "operator" }.compactMap(\.latest)
        XCTAssertEqual(reads.count, 1)
        XCTAssertNotEqual(reads.first?.sessionKey, "agent:main:main")
        self.f26Capture("f26-new-session-before-release", in: app)
        _ = try await self.f26Control("release", body: ["label": label])
        try await self.f26Wait(label, state: "written")
        XCTAssertFalse(app.staticTexts[Self.f26Notice].waitForExistence(timeout: 2))
        self.f26Capture("f26-new-session-after-release", in: app)
    }
}
