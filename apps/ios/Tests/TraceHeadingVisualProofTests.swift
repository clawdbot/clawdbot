import SwiftUI
import UIKit
import XCTest
@testable import OpenClaw
@testable import OpenClawChatUI

@MainActor
final class TraceHeadingVisualProofTests: XCTestCase {
    func testThinkingHeadingStaysSubordinateToFinalHeading() {
        let responseHeading = ChatMarkdownRenderer(
            text: "# Internal plan",
            context: .assistant,
            variant: .standard,
            typography: .response,
            textColor: OpenClawChatTheme.assistantText)
            .environment(\.dynamicTypeSize, .accessibility2)
        let thinkingHeading = ChatMarkdownRenderer(
            text: "# Internal plan",
            context: .assistant,
            variant: .standard,
            typography: .thinking,
            textColor: OpenClawChatTheme.assistantText)
            .environment(\.dynamicTypeSize, .accessibility2)
        let responseHeight = UIHostingController(rootView: responseHeading)
            .sizeThatFits(in: CGSize(width: 393, height: 1000)).height
        let thinkingHeight = UIHostingController(rootView: thinkingHeading)
            .sizeThatFits(in: CGSize(width: 393, height: 1000)).height

        XCTAssertGreaterThan(responseHeight, thinkingHeight)

        let root = VStack(alignment: .leading, spacing: 18) {
            Text(verbatim: "Before: thinking rendered as response")
                .font(OpenClawType.captionSemiBold)
            ChatMarkdownRenderer(
                text: "# Internal plan",
                context: .assistant,
                variant: .standard,
                typography: .response,
                textColor: OpenClawChatTheme.assistantText)

            Divider()

            Text(verbatim: "After: thinking profile")
                .font(OpenClawType.captionSemiBold)
            ChatMarkdownRenderer(
                text: "# Internal plan",
                context: .assistant,
                variant: .standard,
                typography: .thinking,
                textColor: OpenClawChatTheme.assistantText)

            Text(verbatim: "Final response")
                .font(OpenClawType.captionSemiBold)
            ChatMarkdownRenderer(
                text: "# Final answer",
                context: .assistant,
                variant: .standard,
                typography: .response,
                textColor: OpenClawChatTheme.assistantText)
        }
        .padding(24)
        .frame(width: 393, alignment: .leading)
        .environment(\.dynamicTypeSize, .accessibility2)
        .background(Color(uiColor: .systemBackground))

        let controller = UIHostingController(rootView: root)
        let size = controller.sizeThatFits(in: CGSize(width: 393, height: 1000))
        let window = UIWindow(frame: CGRect(origin: .zero, size: size))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()

        let image = UIGraphicsImageRenderer(size: size).image { _ in
            controller.view.drawHierarchy(in: controller.view.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = "trace-heading-before-after-accessibility"
        attachment.lifetime = .keepAlways
        self.add(attachment)

        XCTAssertGreaterThan(image.size.height, 0)
    }
}
