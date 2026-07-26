import Foundation
import XCTest
@testable import OpenClawChatUI

final class ChatMessageMediaAttachmentTests: XCTestCase {
    private actor DecodeBarrier {
        private var entered = false
        private var releaseContinuation: CheckedContinuation<Void, Never>?

        func wait() async {
            self.entered = true
            await withCheckedContinuation { continuation in
                self.releaseContinuation = continuation
            }
        }

        func waitUntilEntered() async {
            while !self.entered {
                await Task.yield()
            }
        }

        func release() {
            self.releaseContinuation?.resume()
            self.releaseContinuation = nil
        }
    }

    private static let managedImagePath =
        "/api/chat/media/outgoing/agent%3Amain%3Amain/00000000-0000-4000-8000-000000000001/full"

    @MainActor func testDecodesManagedAssistantImageFromChatHistory() throws {
        let payload = try JSONDecoder().decode(OpenClawChatHistoryPayload.self, from: Data(
            """
            {
              "sessionKey": "agent:main:main",
              "sessionId": "session-1",
              "messages": [{
                "role": "assistant",
                "content": [
                  {
                    "type": "image",
                    "url": "\(Self.managedImagePath)",
                    "openUrl": "\(Self.managedImagePath)",
                    "alt": "Generated image 1",
                    "mimeType": "image/png",
                    "width": 1,
                    "height": 1
                  }
                ]
              }],
              "thinkingLevel": "off"
            }
            """.utf8))

        let message = try XCTUnwrap(try OpenClawChatViewModel.decodeMessages(XCTUnwrap(payload.messages)).first)
        let image = try XCTUnwrap(message.content.last)

        XCTAssertEqual(message.role, "assistant")
        XCTAssertEqual(message.content.count, 1)
        XCTAssertTrue(image.isInlineAttachment)
        XCTAssertEqual(image.type, "image")
        XCTAssertEqual(image.url, Self.managedImagePath)
        XCTAssertEqual(image.openUrl, Self.managedImagePath)
        XCTAssertEqual(image.alt, "Generated image 1")
        XCTAssertEqual(image.mimeType, "image/png")
    }

    func testTopLevelImageMediaPathIsNotSynthesizedAsAssistantImage() throws {
        let message = try decode(
            """
            {"role":"assistant","content":"Scan this code.",
             "MediaPath":"media/inbound/code.png","MediaType":"image/png"}
            """)

        XCTAssertEqual(message.content.count, 1)
        XCTAssertEqual(message.content.first?.type, "text")
    }

    func testTopLevelUserMediaPathsRemainRenderableAttachments() throws {
        let message = try decode(
            """
            {"role":"user","content":"Review these files.",
             "MediaPaths":[" media/inbound/code.png ","media/inbound/report.pdf"],
             "MediaTypes":[" image/png ","application/pdf"]}
            """)

        XCTAssertEqual(message.content.count, 3)
        XCTAssertEqual(message.content.dropFirst().map(\.type), ["file", "file"])
        XCTAssertEqual(message.content.dropFirst().map(\.mediaPath), [
            "media/inbound/code.png",
            "media/inbound/report.pdf",
        ])
        XCTAssertEqual(message.content.dropFirst().map(\.mimeType), ["image/png", "application/pdf"])
    }

    func testLegacyUserMediaPathsDoNotDuplicateURLBackedContent() throws {
        let message = try decode(
            """
            {"role":"user","content":[
               {"type":"image","url":"media/inbound/code.png","mimeType":"image/png"},
               {"type":"file","openUrl":"media/inbound/report.pdf","mimeType":"application/pdf"}
             ],
             "MediaPaths":[" media/inbound/code.png ","media/inbound/report.pdf"],
             "MediaTypes":["image/png","application/pdf"]}
            """)

        XCTAssertEqual(message.content.count, 2)
        XCTAssertEqual(message.content.map(\.type), ["image", "file"])
        XCTAssertEqual(message.content.map(\.url), ["media/inbound/code.png", nil])
        XCTAssertEqual(message.content.map(\.openUrl), [nil, "media/inbound/report.pdf"])
    }

    func testTopLevelAudioMediaPathRemainsSupported() throws {
        let message = try decode(
            #"{"role":"assistant","content":[],"MediaPath":"/tmp/voice.m4a","MediaType":"audio/mp4"}"#)

        XCTAssertEqual(message.content.count, 1)
        XCTAssertEqual(message.content.first?.type, "file")
        XCTAssertEqual(message.content.first?.mimeType, "audio/mp4")
        XCTAssertEqual(message.content.first?.fileName, "voice.m4a")
    }

    func testExistingAudioBlockPreventsTranscriptAudioDuplicate() throws {
        let message = try decode(
            """
            {"role":"assistant","content":[{"type":"file","mimeType":"audio/mp4","fileName":"voice.m4a"}],
             "MediaPath":"/tmp/voice.m4a","MediaType":"audio/mp4"}
            """)

        XCTAssertEqual(message.content.count, 1)
        XCTAssertEqual(message.content.filter { $0.mimeType == "audio/mp4" }.count, 1)
    }

    func testTopLevelAudioMediaPathsRejectBlanksAndDuplicates() throws {
        let message = try decode(
            """
            {"role":"assistant","content":[],
             "MediaPaths":["   "," /tmp/voice.m4a ","/tmp/voice.m4a","/tmp/missing-type.m4a"],
             "MediaTypes":["audio/mp4"," audio/mp4 ","audio/mp4"]}
            """)

        XCTAssertEqual(message.content.count, 1)
        XCTAssertEqual(message.content.first?.mediaPath, "/tmp/voice.m4a")
        XCTAssertEqual(message.content.first?.mimeType, "audio/mp4")
    }

    func testAttachmentDisplayCapsImagesButPreservesOtherFiles() {
        let images = (0..<6).map { index in
            OpenClawChatMessageContent(
                type: "image",
                text: nil,
                mimeType: "image/png",
                fileName: nil,
                url: "/api/chat/media/outgoing/session/\(index)/full",
                alt: "Generated image \(index + 1)",
                content: nil)
        }
        let document = OpenClawChatMessageContent(
            type: "file",
            text: nil,
            mimeType: "application/pdf",
            fileName: "report.pdf",
            content: nil)

        let presentation = ChatMessageAttachmentDisplayPolicy.partition(images + [document])

        XCTAssertEqual(presentation.visible.count, 5)
        XCTAssertEqual(presentation.visible.last?.fileName, "report.pdf")
        XCTAssertEqual(presentation.omittedImageCount, 2)
    }

    func testManagedImageFieldsSurviveContentRoundTrip() throws {
        let original = OpenClawChatMessageContent(
            type: "image",
            text: nil,
            mimeType: "image/png",
            fileName: nil,
            url: Self.managedImagePath,
            openUrl: Self.managedImagePath,
            alt: "Generated image 1",
            content: nil)

        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(OpenClawChatMessageContent.self, from: encoded)

        XCTAssertEqual(decoded, original)
    }

    func testImageDecoderAcceptsImageAndRejectsNonImageBytes() throws {
        let png = try XCTUnwrap(Data(base64Encoded:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="))

        let image = try XCTUnwrap(ChatMediaImageDecoder.decode(png))
        XCTAssertEqual(image.width, 1)
        XCTAssertEqual(image.height, 1)
        XCTAssertNil(ChatMediaImageDecoder.decode(Data("not an image".utf8)))
    }

    @MainActor func testCancelledImageDecodeDoesNotProduceAnUnavailableReplacementState() async throws {
        let png = try XCTUnwrap(Data(base64Encoded:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="))
        let barrier = DecodeBarrier()
        let task = Task { @MainActor in
            await ChatMediaImageLoader.load(
                Self.managedImagePath,
                loadMedia: { _ in png },
                decode: { data in
                    await barrier.wait()
                    return ChatMediaImageDecoder.decode(data)
                })
        }

        await barrier.waitUntilEntered()
        task.cancel()
        await barrier.release()

        switch await task.value {
        case .cancelled:
            break
        case .loaded, .unavailable:
            XCTFail("A cancelled predecessor must not publish state over its replacement")
        }
    }

    private func decode(_ json: String) throws -> OpenClawChatMessage {
        try JSONDecoder().decode(OpenClawChatMessage.self, from: Data(json.utf8))
    }
}
