import Foundation

public enum PhotoCapture {
    public static func transcodeJPEGForGateway(
        rawData: Data,
        maxWidthPx: Int,
        quality: Double,
        maxPayloadBytes: Int = 5 * 1024 * 1024) throws -> (data: Data, widthPx: Int, heightPx: Int)
    {
        // Base64 inflates payloads by ~4/3; cap encoded bytes so the payload stays under maxPayloadBytes (API limit).
        let maxEncodedBytes = (maxPayloadBytes / 4) * 3
        return try JPEGTranscoder.transcodeToJPEG(
            imageData: rawData,
            maxWidthPx: maxWidthPx,
            quality: quality,
            maxBytes: maxEncodedBytes)
    }
}
