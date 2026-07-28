import XCTest

/// Drives the real share-sheet path: Photos -> share -> OpenClaw compose card.
/// Runs against the booted simulator's bundled sample photos and asserts the
/// compose card's control states without needing a paired gateway (send is
/// expected to surface the not-connected failure inline).
final class ShareExtensionUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        self.continueAfterFailure = false
    }

    func testComposeCardStatesInShareSheet() throws {
        let photos = XCUIApplication(bundleIdentifier: "com.apple.mobileslideshow")
        photos.launch()

        // Photos intermittently shows a "What's New" splash on launch.
        let continueButton = photos.buttons["Continue"].firstMatch
        if continueButton.waitForExistence(timeout: 3) {
            continueButton.tap()
        }

        // Photos restores its last view on launch; only drill into the grid when
        // no photo detail (with its Share button) is already on screen.
        let shareButton = photos.buttons["Share"].firstMatch
        if !shareButton.waitForExistence(timeout: 5) {
            let firstPhoto = photos.scrollViews.images.firstMatch
            guard firstPhoto.waitForExistence(timeout: 10) else {
                throw XCTSkip("Photos library has no images; seed one with `xcrun simctl addmedia`.")
            }
            // Grid thumbnails report as non-hittable while the transition settles;
            // a coordinate tap sidesteps the hittability check reliably.
            firstPhoto.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            if !shareButton.waitForExistence(timeout: 5) {
                firstPhoto.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                XCTAssertTrue(shareButton.waitForExistence(timeout: 10), "Photo detail share button missing")
            }
        }
        shareButton.tap()

        // Target the share-sheet app cell explicitly; label-only matching can hit
        // other OpenClaw builds installed on the same simulator.
        let openClawOption = photos.cells.matching(identifier: "shareCell")
            .matching(NSPredicate(format: "label BEGINSWITH 'OpenClaw'"))
            .firstMatch
        XCTAssertTrue(openClawOption.waitForExistence(timeout: 10), "OpenClaw missing from share sheet")
        openClawOption.tap()

        let draft = photos.textViews["share-compose.draft"]
        let send = photos.buttons["share-compose.send"]
        let cancel = photos.buttons["share-compose.cancel"]
        XCTAssertTrue(draft.waitForExistence(timeout: 15), "Compose draft field missing")
        XCTAssertTrue(send.waitForExistence(timeout: 10), "Send button missing")
        XCTAssertTrue(cancel.exists, "Cancel button missing")

        // Send is also disabled while preparing; wait for the preparing footer to
        // clear so the empty-draft assertions target the ready state.
        let preparing = photos.staticTexts["Preparing share…"]
        XCTAssertTrue(
            self.waitForNonExistence(of: preparing, timeout: 30),
            "Draft preparation did not finish")

        // Image-only share prepares an empty draft: placeholder guidance, send locked.
        XCTAssertTrue(
            self.waitFor(send, enabled: false, timeout: 10),
            "Send must stay disabled for an empty draft")
        self.attachScreenshot(of: photos, named: "compose-empty-draft")

        draft.tap()
        draft.typeText("Describe this image")
        XCTAssertTrue(
            self.waitFor(send, enabled: true, timeout: 10),
            "Send must enable once the draft has text")
        self.attachScreenshot(of: photos, named: "compose-ready")

        // No gateway is paired in this simulator, so the send path must surface
        // the failure inline and hand control back for edits.
        send.tap()
        let failure = photos.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Send failed'")).firstMatch
        XCTAssertTrue(failure.waitForExistence(timeout: 30), "Send failure status missing")
        XCTAssertTrue(
            self.waitFor(send, enabled: true, timeout: 10),
            "Send must re-enable after a failure")
        self.attachScreenshot(of: photos, named: "compose-send-failed")

        cancel.tap()
        XCTAssertTrue(shareButton.waitForExistence(timeout: 10), "Share sheet did not dismiss on cancel")
    }

    private func waitFor(_ element: XCUIElement, enabled: Bool, timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(format: "isEnabled == %@", NSNumber(value: enabled))
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    private func waitForNonExistence(of element: XCUIElement, timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(format: "exists == false")
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    private func attachScreenshot(of app: XCUIApplication, named name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        self.add(attachment)
    }
}
