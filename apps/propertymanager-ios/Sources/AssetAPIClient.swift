import Foundation

extension PropertyAPIClient {
    func fetchAssets() async throws -> [RanchAsset] {
        let url = try makeURL("/assets", versioned: true)
        let (data, response) = try await URLSession.shared.data(from: url)
        try validate(response, data: data)
        return try decoder.decode([RanchAsset].self, from: data)
    }

    func fetchAsset(id: UUID) async throws -> RanchAsset {
        let url = try makeURL("/assets/\(id.uuidString)", versioned: true)
        let (data, response) = try await URLSession.shared.data(from: url)
        try validate(response, data: data)
        return try decoder.decode(RanchAsset.self, from: data)
    }

    func fetchAssetByQR(token: String) async throws -> RanchAsset {
        let url = try makeURL("/assets/by-qr/\(token)", versioned: true)
        let (data, response) = try await URLSession.shared.data(from: url)
        try validate(response, data: data)
        return try decoder.decode(RanchAsset.self, from: data)
    }

    func fetchMeterReadings(assetId: UUID, limit: Int = 50) async throws -> [MeterReading] {
        let url = try makeURL("/assets/\(assetId.uuidString)/meter-readings?limit=\(limit)", versioned: true)
        let (data, response) = try await URLSession.shared.data(from: url)
        try validate(response, data: data)
        let page = try decoder.decode(MeterReadingPage.self, from: data)
        return page.items
    }

    func submitMeterReading(
        assetId: UUID,
        value: Double,
        note: String?,
        entryMethod: String = "manual"
    ) async throws -> RanchAsset {
        let url = try makeURL("/assets/\(assetId.uuidString)/meter-readings", versioned: true)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(to: &request)
        var body: [String: Any] = ["value": String(value), "entry_method": entryMethod]
        if let note, !note.isEmpty { body["note"] = note }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 409 {
            if let preview = try? JSONDecoder().decode(LowerReadingPreview.self, from: data),
               preview.code == "LOWER_READING_CONFIRMATION_REQUIRED" {
                throw PropertyAPIError.lowerReadingConfirmation(preview)
            }
            if let err = try? JSONDecoder().decode(APIErrorBody.self, from: data) {
                throw PropertyAPIError.serverMessage(err.message ?? err.code ?? "Conflict")
            }
        }
        try validate(response, data: data)
        let result = try decoder.decode(MeterReadingResult.self, from: data)
        return result.asset
    }

    func confirmMeterReading(
        assetId: UUID,
        preview: LowerReadingPreview,
        correctionReason: String,
        note: String? = nil
    ) async throws -> RanchAsset {
        let url = try makeURL("/assets/\(assetId.uuidString)/meter-readings/confirm", versioned: true)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(to: &request)
        var body: [String: Any] = [
            "preview_token": preview.previewToken,
            "correction_reason": correctionReason,
            "operator_identity": operatorIdentity ?? "ios-operator",
        ]
        if let note, !note.isEmpty { body["note"] = note }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response, data: data)
        let result = try decoder.decode(MeterReadingResult.self, from: data)
        return result.asset
    }

    func activateMeter(assetId: UUID) async throws -> RanchAsset {
        let url = try makeURL("/assets/\(assetId.uuidString)/activate-meter", versioned: true)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(to: &request)
        request.httpBody = try JSONSerialization.data(withJSONObject: [:] as [String: String])
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response, data: data)
        let result = try decoder.decode(ActivateMeterResult.self, from: data)
        return result.asset
    }

    func parseMeterText(_ text: String) async throws -> MeterParseResult {
        let url = try makeURL("/meter-readings/parse", versioned: true)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(to: &request)
        request.httpBody = try JSONSerialization.data(withJSONObject: ["text": text])
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response, data: data)
        return try JSONDecoder().decode(MeterParseResult.self, from: data)
    }
}

private struct MeterReadingPage: Codable {
    var items: [MeterReading]
    var nextCursor: String?

    enum CodingKeys: String, CodingKey {
        case items
        case nextCursor = "next_cursor"
    }
}

private struct MeterReadingResult: Codable {
    var asset: RanchAsset
}

private struct ActivateMeterResult: Codable {
    var asset: RanchAsset
    var meter: AssetMeter?
}
