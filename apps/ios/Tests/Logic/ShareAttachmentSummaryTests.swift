import Foundation
import Testing

struct ShareAttachmentSummaryTests {
    @Test func `has no omission message when every selected image is accepted`() {
        let summary = ShareAttachmentSummary(selectedImageCount: 3, acceptedImageCount: 3)

        #expect(summary.omissionMessage == nil)
    }

    @Test func `reports image truncation before the share can be sent`() {
        let summary = ShareAttachmentSummary(selectedImageCount: 6, acceptedImageCount: 3)

        #expect(summary.omissionMessage ==
            "Only 3 of 6 images can be sent. Remove omitted items and share again.")
    }

    @Test func `reports unsupported videos files and unknown attachments`() {
        let summary = ShareAttachmentSummary(
            selectedImageCount: 1,
            acceptedImageCount: 1,
            videoCount: 1,
            fileCount: 2,
            unknownCount: 1)

        #expect(summary.omissionMessage ==
            "OpenClaw Share cannot send 1 video, 2 files, 1 unsupported item yet. Remove omitted items and share again.")
    }

    @Test func `counts an unclassified provider only when no content was loaded`() {
        var summary = ShareAttachmentSummary()

        summary.recordUnclassifiedProvider(didLoadContent: true)
        #expect(summary.unknownCount == 0)

        summary.recordUnclassifiedProvider(didLoadContent: false)
        #expect(summary.unknownCount == 1)
    }

    @Test func `keeps image processing failures authoritative before omission warnings`() {
        let summary = ShareAttachmentSummary(selectedImageCount: 2, acceptedImageCount: 1)

        #expect(ShareAttachmentBlockReason.resolve(
            hasImageProcessingError: true,
            summary: summary) == .imageProcessingFailed)
    }

    @Test func `uses omission warning when no image processing failure exists`() {
        let summary = ShareAttachmentSummary(selectedImageCount: 6, acceptedImageCount: 3)

        #expect(ShareAttachmentBlockReason.resolve(
            hasImageProcessingError: false,
            summary: summary) == .omitted(
            "Only 3 of 6 images can be sent. Remove omitted items and share again."))
    }
}
