import Foundation
import CryptoKit

/// The Whisper model a capable Apple Watch writes speech down with, pinned file by file. The files are argmax's Core ML
/// build of OpenAI's Whisper (huggingface.co/argmaxinc/whisperkit-coreml) at one revision, and the tokenizer files of
/// the same model from OpenAI's own repository at one revision. Each file's size and SHA-256 are written here: the
/// iPhone checks them after downloading, and the Watch checks them again after WatchConnectivity has carried the file,
/// so a file that changed upstream or arrived damaged is never used. The large files' SHA-256 are the ones Hugging Face
/// publishes for them (their Git LFS ids); the small ones were hashed from the same revision.
public struct SpeechModel: Equatable, Sendable {
    public struct File: Equatable, Sendable {
        public let path: String
        public let size: Int64
        public let sha256: String
        init(_ path: String, _ size: Int64, _ sha256: String) { self.path = path; self.size = size; self.sha256 = sha256 }
    }

    /// The folder name WhisperKit knows the model by.
    public let name: String
    public let files: [File]
    /// OpenAI's repository with this model's tokenizer, and its pinned revision.
    let tokenizerRepo: String
    let tokenizerRevision: String

    /// The whisperkit-coreml revision every model file comes from.
    public static let revision = "0f63a7800b00dd0226abd051b906c246e1907482"
    static let tokenizerFiles: Set<String> = ["tokenizer.json", "tokenizer_config.json"]

    public var bytes: Int64 { files.reduce(0) { $0 + $1.size } }

    public func file(_ path: String) -> File? { files.first { $0.path == path } }

    /// Where the iPhone downloads a file from: the pinned revision, never a branch that can move.
    public func url(_ f: File) -> URL {
        if Self.tokenizerFiles.contains(f.path) {
            return URL(string: "https://huggingface.co/\(tokenizerRepo)/resolve/\(tokenizerRevision)/\(f.path)")!
        }
        return URL(string: "https://huggingface.co/argmaxinc/whisperkit-coreml/resolve/\(Self.revision)/\(name)/\(f.path)")!
    }

    public static var all: [SpeechModel] { [baseEn, base] }
    public static func named(_ name: String) -> SpeechModel? { all.first { $0.name == name } }

    /// English locales use the English-only model, which hears English better at the same size; every other language
    /// the multilingual one. The owner chose base over tiny (about twice the work) as long as the words still show a
    /// second or two after they stop.
    public static func forLocale(_ locale: Locale) -> SpeechModel {
        (locale.language.languageCode?.identifier ?? "en") == "en" ? baseEn : base
    }

    /// The language to tell the model, a two letter code; nil lets the multilingual model find it.
    public static func language(_ locale: Locale) -> String? {
        let code = locale.language.languageCode?.identifier ?? ""
        return code.count == 2 ? code : nil
    }

    public static let baseEn = SpeechModel(
        name: "openai_whisper-base.en",
        files: [
            File("AudioEncoder.mlmodelc/analytics/coremldata.bin", 243, "c4e096b2abd561f00b9b698401df3fbe1a0d0c8d2476ff19cb4e1995680e827e"),
            File("AudioEncoder.mlmodelc/coremldata.bin", 347, "e316980638e2099e83cb1a93b903717dc12b3c2168d0ab69113764c3767696ba"),
            File("AudioEncoder.mlmodelc/metadata.json", 1863, "d6785fae31c3f86d60058c14c79902f716f106dd9e36af7d3fe78b9c34867fce"),
            File("AudioEncoder.mlmodelc/model.mil", 579125, "dc74813e26fce790fe22a33dcef8be535b9dce566f38a8bdb677f5e07dcf9138"),
            File("AudioEncoder.mlmodelc/model.mlmodel", 79853, "1d42038f84b508da5ce9b953302387ffedc097c346d36a56b765109002b6080e"),
            File("AudioEncoder.mlmodelc/weights/weight.bin", 41189632, "74f15e6d2f7694af54e90227cbf22fd6c04082638f163b78a909967b16edc1c7"),
            File("MelSpectrogram.mlmodelc/analytics/coremldata.bin", 243, "7f77e6457285248f99cd7aa3fd4cc2efbb17733e63e7023ac53abe1f95785d07"),
            File("MelSpectrogram.mlmodelc/coremldata.bin", 328, "dabdc5aa69f6ef4d97dc9499f5c30514e00e96b53b750b33a5a6471363c71662"),
            File("MelSpectrogram.mlmodelc/metadata.json", 1848, "66a60d0babfcae566910a6d699471efde002d92205a7d349e16989ca4d6729d3"),
            File("MelSpectrogram.mlmodelc/model.mil", 10176, "b8063d8e57c113472ac7c2d248e44383568a018978a753c1884ac406b997a374"),
            File("MelSpectrogram.mlmodelc/weights/weight.bin", 354080, "ee77f9b67765f7abc33f16374081b2389cf1d3a89536187b241950c5a2e5d6c1"),
            File("TextDecoder.mlmodelc/analytics/coremldata.bin", 243, "e870aac5de88676c1ad93cb3939f257e6de30e5235c3f9d7686398ebecafdb8d"),
            File("TextDecoder.mlmodelc/coremldata.bin", 633, "4b23ff9d9fe376f2b86f9cf55af3218560a4e4d692041360510fbad490c0db43"),
            File("TextDecoder.mlmodelc/metadata.json", 4753, "da9be60fd96a13938445fd589a54bf56f77474efd541027bfb79537ddf67d10c"),
            File("TextDecoder.mlmodelc/model.mil", 200444, "e380edc70b68dc1e06c1ae19aaa8fd5f85a2b14242b9cc871ce5648cfb3ed3ce"),
            File("TextDecoder.mlmodelc/model.mlmodel", 160348, "72f1214f7c8b26e467dd8233572eaa5cbe200f30a36b918d4c289f9fc8c4f401"),
            File("TextDecoder.mlmodelc/weights/weight.bin", 104121136, "4649599bd2d97f87ffc716e6da2f61a06c06ac5a9424dd23edc3d4bf66fb6221"),
            File("config.json", 1454, "ab22779256bdb966a5dc4f033cb9ac6471e0e1e2574fda258655c8ad2a5ea700"),
            File("generation_config.json", 982, "ea4714d2f89ab6de18c6dead99c10fbeeb383768fa6b564d9d4d7889140d70b5"),
            File("tokenizer.json", 2405679, "5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0"),
            File("tokenizer_config.json", 805, "14f84bdf4b9ecdbd4738ddc81c17a1baedfc02bb93c6e049c951e15a1b40b70d"),
        ],
        tokenizerRepo: "openai/whisper-base.en",
        tokenizerRevision: "911407f4214e0e1d82085af863093ec0b66f9cd6"
    )

    public static let base = SpeechModel(
        name: "openai_whisper-base",
        files: [
            File("AudioEncoder.mlmodelc/analytics/coremldata.bin", 243, "c4e096b2abd561f00b9b698401df3fbe1a0d0c8d2476ff19cb4e1995680e827e"),
            File("AudioEncoder.mlmodelc/coremldata.bin", 347, "e316980638e2099e83cb1a93b903717dc12b3c2168d0ab69113764c3767696ba"),
            File("AudioEncoder.mlmodelc/metadata.json", 1863, "d6785fae31c3f86d60058c14c79902f716f106dd9e36af7d3fe78b9c34867fce"),
            File("AudioEncoder.mlmodelc/model.mil", 579125, "dc74813e26fce790fe22a33dcef8be535b9dce566f38a8bdb677f5e07dcf9138"),
            File("AudioEncoder.mlmodelc/model.mlmodel", 79853, "1d42038f84b508da5ce9b953302387ffedc097c346d36a56b765109002b6080e"),
            File("AudioEncoder.mlmodelc/weights/weight.bin", 41189632, "061ff4d74e5de3937b31288465d6c6f2697f92d121c80b23f51dd26bbdfe642b"),
            File("MelSpectrogram.mlmodelc/analytics/coremldata.bin", 243, "7f77e6457285248f99cd7aa3fd4cc2efbb17733e63e7023ac53abe1f95785d07"),
            File("MelSpectrogram.mlmodelc/coremldata.bin", 328, "dabdc5aa69f6ef4d97dc9499f5c30514e00e96b53b750b33a5a6471363c71662"),
            File("MelSpectrogram.mlmodelc/metadata.json", 1848, "f2b08d80d9cdd39fc0ccdbb5fac86a5f8dd9bcaa839706c3568be6fe8abd82d4"),
            File("MelSpectrogram.mlmodelc/model.mil", 10176, "b8063d8e57c113472ac7c2d248e44383568a018978a753c1884ac406b997a374"),
            File("MelSpectrogram.mlmodelc/weights/weight.bin", 354080, "35d74417ef9c765e70f4ef85fe7405015a7086e9af05e3b63a5c2c7c748b2efc"),
            File("TextDecoder.mlmodelc/analytics/coremldata.bin", 243, "6ac1227740ecc2fd7a03df50ac6e2a7f7946acfa77069cf2c486ae0255356b95"),
            File("TextDecoder.mlmodelc/coremldata.bin", 633, "9f1f6fe409486e2797d3f0c65d9a6d5af596771760548cd86f41939c54cdbe7c"),
            File("TextDecoder.mlmodelc/metadata.json", 4753, "0a64b3686b9a4b2eff0792e7df3cfe1b20467ec5d5ac52c0e01c3dbf6697b65d"),
            File("TextDecoder.mlmodelc/model.mil", 205217, "45b9e61a0f286cddcad96e2c890c7a68460adcaa3319c4907ee4f962dfeb2c8b"),
            File("TextDecoder.mlmodelc/model.mlmodel", 164481, "ae260ff7b95d0c957c3c1f4df4dbeaa0ae6c76bacc55eb86caca8f6820d346f0"),
            File("TextDecoder.mlmodelc/weights/weight.bin", 104122162, "72325d42a4a4ccc8a6fa974ede6cdf2e0770685a5c4f9da94f41495b94d8d174"),
            File("config.json", 1464, "67e25477d03bf3a1c34bfd137724beed94b5218d0457e8c1d25f70379a61d9d5"),
            File("generation_config.json", 2762, "662a99e3db3067708549d04d5f141910eb455f0935aed0c9b06d707f44bfbcaf"),
            File("tokenizer.json", 2480466, "27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566"),
            File("tokenizer_config.json", 282683, "2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce"),
        ],
        tokenizerRepo: "openai/whisper-base",
        tokenizerRevision: "e37978b90ca9030d5170a5c07aadb050351a65bb"
    )
}

/// Model files kept on one device, a folder per model laid out as WhisperKit reads it (`<name>/AudioEncoder.mlmodelc/...`
/// with the tokenizer files at the top). A file is put in place only after its size and SHA-256 matched, so a file
/// that is there with its full size is a checked one; nothing is hashed again at launch.
public struct SpeechModelStore: Sendable {
    public let folder: URL

    public init(folder: URL) { self.folder = folder }

    /// This device's store, in Application Support and out of iCloud Backup (it can always be fetched again).
    public static var local: SpeechModelStore {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        return SpeechModelStore(folder: base.appendingPathComponent("speech-models", isDirectory: true))
    }

    public func modelFolder(_ m: SpeechModel) -> URL { folder.appendingPathComponent(m.name, isDirectory: true) }
    public func url(_ m: SpeechModel, _ f: SpeechModel.File) -> URL { modelFolder(m).appendingPathComponent(f.path) }

    public func has(_ m: SpeechModel, _ f: SpeechModel.File) -> Bool {
        let size = (try? FileManager.default.attributesOfItem(atPath: url(m, f).path)[.size] as? NSNumber)?.int64Value
        return size == f.size
    }

    /// Files not here yet, in the model's order.
    public func missing(_ m: SpeechModel) -> [SpeechModel.File] { m.files.filter { !has(m, $0) } }
    public func isComplete(_ m: SpeechModel) -> Bool { missing(m).isEmpty }
    public func bytesHere(_ m: SpeechModel) -> Int64 { m.files.filter { has(m, $0) }.reduce(0) { $0 + $1.size } }

    public enum Refusal: Error, Equatable {
        case unknownFile(String)
        case wrongSize(String)
        case wrongChecksum(String)
    }

    /// Checks a downloaded or received file against the pinned size and SHA-256, then moves it into place. The file is
    /// moved (or, where it cannot be, copied); a file that does not match is deleted and refused.
    public func accept(_ file: URL, as path: String, for m: SpeechModel) throws {
        guard let f = m.file(path) else {
            try? FileManager.default.removeItem(at: file)
            throw Refusal.unknownFile(path)
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.int64Value
        guard size == f.size else {
            try? FileManager.default.removeItem(at: file)
            throw Refusal.wrongSize(path)
        }
        guard try Self.sha256(file) == f.sha256 else {
            try? FileManager.default.removeItem(at: file)
            throw Refusal.wrongChecksum(path)
        }
        let dest = url(m, f)
        let fm = FileManager.default
        try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
        excludeFromBackup(folder)
        try? fm.removeItem(at: dest)
        do { try fm.moveItem(at: file, to: dest) } catch { try fm.copyItem(at: file, to: dest) }
    }

    public func remove(_ m: SpeechModel) { try? FileManager.default.removeItem(at: modelFolder(m)) }

    /// Every model folder here but `keep` (a Watch whose language changed keeps only the model it uses now).
    public func removeAll(except keep: SpeechModel?) {
        for m in SpeechModel.all where m != keep { remove(m) }
    }

    /// SHA-256 of a file, read a megabyte at a time: the decoder's weights are about 100 MB.
    public static func sha256(_ file: URL) throws -> String {
        let h = try FileHandle(forReadingFrom: file)
        defer { try? h.close() }
        var hasher = SHA256()
        while true {
            let chunk = try h.read(upToCount: 1 << 20) ?? Data()
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private func excludeFromBackup(_ url: URL) {
        var u = url
        var v = URLResourceValues()
        v.isExcludedFromBackup = true
        try? u.setResourceValues(v)
    }
}

/// What the Watch tells the iPhone about writing speech down itself, in its WatchConnectivity application context
/// (the newest one always wins and waits for the iPhone): which model it wants (nil: this Watch cannot run one, or does
/// not want one), the files it still lacks, whether it has the whole model, and how long the model took the last time.
public struct WatchSpeechState: Equatable, Sendable {
    public static let key = "speech_model"

    public var model: String?
    public var missing: [String]
    /// WhisperKit's name for the device ("Watch7,9"), for the iPhone's log.
    public var device: String
    /// How the model last did on this Watch, in seconds, for the iPhone's log (`SpeechTimings`): never words.
    public var timings: [String: Double]

    public init(model: String?, missing: [String], device: String, timings: [String: Double] = [:]) {
        self.model = model; self.missing = missing; self.device = device; self.timings = timings
    }

    public var ready: Bool { model != nil && missing.isEmpty }

    /// The Watch's state for one model in its store.
    public init(model: SpeechModel?, store: SpeechModelStore, device: String, timings: [String: Double] = [:]) {
        self.init(model: model?.name, missing: model.map { store.missing($0).map(\.path) } ?? [], device: device, timings: timings)
    }

    public var context: [String: Any] {
        var s: [String: Any] = ["model": model ?? "", "missing": missing, "device": device]
        if !timings.isEmpty { s["timings"] = timings }
        return [Self.key: s]
    }

    /// Nil when the context holds no speech state, or one naming a model the iPhone does not know.
    public init?(context: [String: Any]) {
        guard let s = context[Self.key] as? [String: Any] else { return nil }
        let name = (s["model"] as? String) ?? ""
        if !name.isEmpty, SpeechModel.named(name) == nil { return nil }
        model = name.isEmpty ? nil : name
        missing = ((s["missing"] as? [String]) ?? []).filter { p in SpeechModel.named(name)?.file(p) != nil }
        device = (s["device"] as? String) ?? ""
        // Numbers only, and only the ones this app knows (the context comes from the other device).
        let given = (s["timings"] as? [String: Any]) ?? [:]
        timings = given.reduce(into: [:]) { out, e in
            if SpeechTimings.keys.contains(e.key), let n = e.value as? NSNumber, n.doubleValue.isFinite { out[e.key] = n.doubleValue }
        }
    }
}

/// How the Watch's speech model last did on that Watch, in seconds. Nothing has to be measured by hand: the Watch
/// keeps these as it goes and tells the iPhone (`WatchSpeechState.timings`), whose log then says how a real Watch
/// manages (the simulator runs the model on the Mac's processor, which says little). Never words or audio.
public enum SpeechTimings {
    /// Loading the model into memory, the last time.
    public static let load = "load"
    /// The first load on this Watch, when Core ML also prepares the model for its chip (the long one).
    public static let firstLoad = "first_load"
    /// The pass after Done, and the length of the recording it heard.
    public static let heard = "heard"
    public static let heardAudio = "heard_audio"
    /// The latest live pass, and the speech it heard.
    public static let pass = "pass"
    public static let passAudio = "pass_audio"
    /// From the start of the latest capture to its first live words.
    public static let firstWords = "first_words"
    /// 1 when the latest capture was recorded through the live recorder, 0 when that could not start.
    public static let live = "live"

    public static let keys: Set<String> = [load, firstLoad, heard, heardAudio, pass, passAudio, firstWords, live]

    /// One line for a log: "first_load 41.2, heard 2.1, heard_audio 6.4".
    public static func line(_ t: [String: Double]) -> String {
        t.keys.sorted().map { "\($0) \(String(format: "%.1f", t[$0] ?? 0))" }.joined(separator: ", ")
    }
}

/// One model file carried from the iPhone to the Watch: the WatchConnectivity file transfer's metadata.
public struct SpeechModelTransfer: Equatable, Sendable {
    public static let kind = "speech-model-file"
    public var model: String
    public var path: String

    public init(model: String, path: String) { self.model = model; self.path = path }

    public var metadata: [String: Any] { ["kind": Self.kind, "model": model, "path": path] }

    /// Nil for any other transfer, and for a file the pinned model does not list (the path names a file on the Watch).
    public init?(metadata: [String: Any]?) {
        guard let m = metadata, m["kind"] as? String == Self.kind, let model = m["model"] as? String,
              let path = m["path"] as? String, SpeechModel.named(model)?.file(path) != nil else { return nil }
        self.model = model; self.path = path
    }
}

/// What the hub says about the Watch's speech model (`GET /speech-models/:name`): it fetches the model from Hugging
/// Face on the first ask, so the apps never contact anyone but the hub.
public struct HubSpeechModelState: Decodable, Equatable, Sendable {
    /// ready, fetching, missing or failed.
    public let state: String
    public let bytes: Int64
    public let total: Int64
    public let error: String?
}

public extension HubClient {
    /// `GET /speech-models/:name`; asking starts the hub's fetch when it does not have the model yet.
    func speechModelState(_ name: String) async throws -> HubSpeechModelState {
        try decode(HubSpeechModelState.self, try await send("GET", "speech-models/\(name)"))
    }

    /// `GET /speech-models/:name/file?path=`: one checked file's bytes (409 while the hub has not fetched it).
    func speechModelFile(_ name: String, path: String) async throws -> Data {
        try await send("GET", "speech-models/\(name)/file", query: ["path": path])
    }
}
