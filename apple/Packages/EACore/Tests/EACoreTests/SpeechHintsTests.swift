import XCTest
@testable import EACore

final class SpeechHintsTests: XCTestCase {
    private func entity(_ kind: String, _ id: String, updated: String = "2026-11-01T00:00:00.000Z", deleted: Bool = false, _ fields: String) throws -> Entity {
        try JSONCoding.decode(Entity.self, from: #"{"id":"\#(id)","kind":"\#(kind)","space":"personal","created_at":"2026-10-01T00:00:00.000Z","updated_at":"\#(updated)","deleted_at":\#(deleted ? #""2026-11-02T00:00:00.000Z""# : "null"),"fields":\#(fields),"field_ts":{}}"#)
    }

    func testExpectedWordsComeFirstAndCoverWhatAeneasFiles() {
        let w = SpeechHints.words(people: [], projects: [], pet: "")
        XCTAssertEqual(Array(w.prefix(2)), ["remind me", "to do"])
        // The owner's case: "weigh" and "pounds" are expected, so "Highway 192.2" loses to "I weigh 192.2".
        for word in ["weigh", "weight", "pounds", "kilograms", "remind me", "blood pressure", "slept", "steps", "caffeine", "mood"] {
            XCTAssertTrue(w.contains(word), word)
        }
        // Every log type but custom is said some way.
        for t in LogType.allCases where t != .custom { XCTAssertFalse(SpeechHints.spoken(t).isEmpty, t.rawValue) }
        XCTAssertEqual(w, SpeechHints.expected)
    }

    func testPetPeopleAndProjectsFollowInOrder() throws {
        let people = [
            try entity("person", "p1", updated: "2026-11-10T00:00:00.000Z", #"{"name":"Devon Park"}"#),
            try entity("person", "p2", updated: "2026-10-01T00:00:00.000Z", #"{"name":"Jamie Rivera","nickname":"Jay","relationship":"girlfriend"}"#),
            try entity("person", "p3", deleted: true, #"{"name":"Gone Person"}"#),
            try entity("person", "p4", #"{"name":"Merged Copy","merged_into":"p2"}"#),
            // The same name twice (any case) is listed once.
            try entity("person", "p5", updated: "2026-11-09T00:00:00.000Z", #"{"name":"devon park"}"#),
        ]
        let projects = [
            try entity("project", "j1", #"{"name":"Aeneas","status":"active"}"#),
            try entity("project", "j2", #"{"name":"Old Shed","status":"done"}"#),
            try entity("project", "j3", #"{"name":"Garden Beds","status":"parked"}"#),
        ]
        let w = SpeechHints.words(people: people, projects: projects, pet: "Biscuit")
        let tail = Array(w.dropFirst(SpeechHints.expected.count))
        // The pet, then people the owner described, then the most recently changed, then active projects first.
        XCTAssertEqual(tail, ["Biscuit", "Jamie Rivera", "Jay", "Devon Park", "Aeneas", "Garden Beds"])
    }

    func testTheListIsCapped() throws {
        var people: [Entity] = []
        for i in 0..<200 { people.append(try entity("person", "p\(i)", #"{"name":"Person Number \#(i)"}"#)) }
        let w = SpeechHints.words(people: people, projects: [], pet: "Biscuit")
        XCTAssertLessThanOrEqual(w.count, SpeechHints.maxWords)
        XCTAssertLessThanOrEqual(w.reduce(0) { $0 + $1.count }, SpeechHints.maxCharacters)
        XCTAssertLessThanOrEqual(w.filter { $0.hasPrefix("Person Number") }.count, SpeechHints.maxPeople)
        // The expected words are never pushed out by people.
        XCTAssertEqual(Array(w.prefix(SpeechHints.expected.count)), SpeechHints.expected)
        // A name too long to be a name is left out.
        let long = SpeechHints.words(people: [try entity("person", "x", #"{"name":"\#(String(repeating: "a", count: 41))"}"#)], projects: [], pet: "")
        XCTAssertEqual(long, SpeechHints.expected)
    }

    func testPromptAndContextRoundTrip() {
        let w = ["weigh", "pounds", "Biscuit"]
        XCTAssertEqual(SpeechHints.prompt(w), "weigh, pounds, Biscuit")
        let ctx = SpeechHints.context(w)
        XCTAssertTrue(PropertyListSerialization.propertyList(ctx, isValidFor: .binary))
        XCTAssertEqual(SpeechHints.words(context: ctx), w)
        XCTAssertNil(SpeechHints.words(context: [:]))
        // From another device: cleaned and capped again.
        let messy: [String: Any] = [SpeechHints.contextKey: [" weigh ", "", String(repeating: "b", count: 80)] + Array(repeating: "x", count: 100)]
        let got = SpeechHints.words(context: messy) ?? []
        XCTAssertEqual(got.first, "weigh")
        XCTAssertLessThanOrEqual(got.count, SpeechHints.maxWords)
        XCTAssertFalse(got.contains(""))
    }
}

final class SpeechModelTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("speech-model-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: folder) }

    /// A made-up model whose files are small enough to write in a test.
    private func tiny() -> (SpeechModel, [String: Data]) {
        let a = Data("encoder".utf8), b = Data("tokenizer".utf8)
        func sha(_ d: Data) -> String {
            let url = folder.appendingPathComponent(UUID().uuidString)
            try? d.write(to: url)
            return (try? SpeechModelStore.sha256(url)) ?? ""
        }
        let m = SpeechModel(name: "test-model", files: [
            .init("AudioEncoder.mlmodelc/weights/weight.bin", Int64(a.count), sha(a)),
            .init("tokenizer.json", Int64(b.count), sha(b)),
        ], tokenizerRepo: "openai/whisper-test", tokenizerRevision: "abc")
        return (m, ["AudioEncoder.mlmodelc/weights/weight.bin": a, "tokenizer.json": b])
    }

    private func write(_ d: Data) throws -> URL {
        let url = folder.appendingPathComponent("download-\(UUID().uuidString)")
        try d.write(to: url)
        return url
    }

    func testModelForTheLanguage() {
        XCTAssertEqual(SpeechModel.forLocale(Locale(identifier: "en_US")).name, "openai_whisper-base.en")
        XCTAssertEqual(SpeechModel.forLocale(Locale(identifier: "en_GB")).name, "openai_whisper-base.en")
        XCTAssertEqual(SpeechModel.forLocale(Locale(identifier: "de_DE")).name, "openai_whisper-base")
        XCTAssertEqual(SpeechModel.language(Locale(identifier: "fr_FR")), "fr")
        XCTAssertEqual(SpeechModel.named("openai_whisper-base"), SpeechModel.base)
        XCTAssertNil(SpeechModel.named("openai_whisper-large-v3"))
    }

    func testPinnedFilesAndAddresses() {
        for m in SpeechModel.all {
            // The Core ML parts, their configs and the tokenizer WhisperKit reads from the same folder.
            for part in ["AudioEncoder.mlmodelc/weights/weight.bin", "TextDecoder.mlmodelc/weights/weight.bin", "MelSpectrogram.mlmodelc/coremldata.bin", "config.json", "tokenizer.json", "tokenizer_config.json"] {
                XCTAssertNotNil(m.file(part), "\(m.name) \(part)")
            }
            XCTAssertTrue(m.files.allSatisfy { $0.sha256.count == 64 && $0.size > 0 })
            XCTAssertEqual(Set(m.files.map(\.path)).count, m.files.count)
            // About 150 MB: what the iPhone fetches once and the Watch keeps.
            XCTAssertGreaterThan(m.bytes, 140_000_000)
            XCTAssertLessThan(m.bytes, 160_000_000)
            // Pinned revisions, never a branch.
            for f in m.files { XCTAssertFalse(m.url(f).absoluteString.contains("/main/"), f.path) }
        }
        XCTAssertEqual(SpeechModel.baseEn.url(SpeechModel.baseEn.file("config.json")!).absoluteString,
                       "https://huggingface.co/argmaxinc/whisperkit-coreml/resolve/\(SpeechModel.revision)/openai_whisper-base.en/config.json")
        XCTAssertEqual(SpeechModel.baseEn.url(SpeechModel.baseEn.file("tokenizer.json")!).absoluteString,
                       "https://huggingface.co/openai/whisper-base.en/resolve/911407f4214e0e1d82085af863093ec0b66f9cd6/tokenizer.json")
    }

    func testStoreTakesOnlyFilesThatMatch() throws {
        let (m, data) = tiny()
        let store = SpeechModelStore(folder: folder.appendingPathComponent("store"))
        XCTAssertEqual(store.missing(m).count, 2)
        XCTAssertFalse(store.isComplete(m))
        // Wrong bytes of the right size, the wrong size, a file the model does not list: each refused and deleted.
        let wrong = try write(Data("ENCODER".utf8))
        XCTAssertThrowsError(try store.accept(wrong, as: "AudioEncoder.mlmodelc/weights/weight.bin", for: m)) { XCTAssertEqual($0 as? SpeechModelStore.Refusal, .wrongChecksum("AudioEncoder.mlmodelc/weights/weight.bin")) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: wrong.path))
        XCTAssertThrowsError(try store.accept(try write(Data("enc".utf8)), as: "AudioEncoder.mlmodelc/weights/weight.bin", for: m)) { XCTAssertEqual($0 as? SpeechModelStore.Refusal, .wrongSize("AudioEncoder.mlmodelc/weights/weight.bin")) }
        XCTAssertThrowsError(try store.accept(try write(Data("x".utf8)), as: "../../escape", for: m)) { XCTAssertEqual($0 as? SpeechModelStore.Refusal, .unknownFile("../../escape")) }
        XCTAssertEqual(store.missing(m).count, 2)
        // The right file goes in place, laid out as WhisperKit reads it.
        try store.accept(try write(data["AudioEncoder.mlmodelc/weights/weight.bin"]!), as: "AudioEncoder.mlmodelc/weights/weight.bin", for: m)
        XCTAssertEqual(store.missing(m).map(\.path), ["tokenizer.json"])
        XCTAssertEqual(store.bytesHere(m), Int64(data["AudioEncoder.mlmodelc/weights/weight.bin"]!.count))
        try store.accept(try write(data["tokenizer.json"]!), as: "tokenizer.json", for: m)
        XCTAssertTrue(store.isComplete(m))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.modelFolder(m).appendingPathComponent("AudioEncoder.mlmodelc/weights/weight.bin").path))
        store.remove(m)
        XCTAssertEqual(store.missing(m).count, 2)
    }

    func testWatchStateRoundTripsAndRefusesUnknownModels() {
        let store = SpeechModelStore(folder: folder)
        let s = WatchSpeechState(model: SpeechModel.baseEn, store: store, device: "Watch7,9")
        XCTAssertEqual(s.model, "openai_whisper-base.en")
        XCTAssertEqual(s.missing.count, SpeechModel.baseEn.files.count)
        XCTAssertFalse(s.ready)
        XCTAssertTrue(PropertyListSerialization.propertyList(s.context, isValidFor: .binary))
        XCTAssertEqual(WatchSpeechState(context: s.context), s)
        // A Watch that cannot run it says so with no model.
        let none = WatchSpeechState(model: nil, store: store, device: "Watch6,14")
        XCTAssertEqual(WatchSpeechState(context: none.context)?.model, nil)
        XCTAssertFalse(none.ready)
        XCTAssertNil(WatchSpeechState(context: [:]))
        XCTAssertNil(WatchSpeechState(context: [WatchSpeechState.key: ["model": "something-else", "missing": [], "device": "x"]]))
        // Paths the model does not list are dropped: they would name files on the iPhone.
        let odd = WatchSpeechState(context: [WatchSpeechState.key: ["model": "openai_whisper-base.en", "missing": ["config.json", "../../x"], "device": "Watch7,9"]])
        XCTAssertEqual(odd?.missing, ["config.json"])
        XCTAssertTrue(WatchSpeechState(model: "openai_whisper-base.en", missing: [], device: "Watch7,9").ready)
    }

    func testWatchStateCarriesItsTimingsAsNumbersOnly() {
        let t = [SpeechTimings.firstLoad: 41.2, SpeechTimings.load: 3.4, SpeechTimings.heard: 2.1, SpeechTimings.heardAudio: 6.4, SpeechTimings.live: 1]
        let s = WatchSpeechState(model: "openai_whisper-base.en", missing: [], device: "Watch7,9", timings: t)
        XCTAssertTrue(PropertyListSerialization.propertyList(s.context, isValidFor: .binary))
        XCTAssertEqual(WatchSpeechState(context: s.context), s)
        XCTAssertEqual(WatchSpeechState(context: s.context)?.timings, t)
        // New timings are a new state, so the iPhone hears of them; none at all is what an older Watch app sends.
        XCTAssertNotEqual(s, WatchSpeechState(model: "openai_whisper-base.en", missing: [], device: "Watch7,9"))
        XCTAssertEqual(WatchSpeechState(context: [WatchSpeechState.key: ["model": "openai_whisper-base.en", "missing": [String](), "device": "Watch7,9"]])?.timings, [:])
        // Only numbers under the names this app knows: anything else from the other device is dropped.
        let odd = WatchSpeechState(context: [WatchSpeechState.key: ["model": "openai_whisper-base.en", "missing": [String](), "device": "Watch7,9",
                                                                     "timings": ["load": 2.5, "heard": "I weigh 192", "words": 3.0, "pass": Double.infinity] as [String: Any]]])
        XCTAssertEqual(odd?.timings, ["load": 2.5])
        XCTAssertEqual(SpeechTimings.line(t), "first_load 41.2, heard 2.1, heard_audio 6.4, live 1.0, load 3.4")
        XCTAssertEqual(SpeechTimings.line([:]), "")
    }

    func testTransferMetadataNamesOnlyPinnedFiles() {
        let t = SpeechModelTransfer(model: "openai_whisper-base.en", path: "tokenizer.json")
        XCTAssertTrue(PropertyListSerialization.propertyList(t.metadata, isValidFor: .binary))
        XCTAssertEqual(SpeechModelTransfer(metadata: t.metadata), t)
        XCTAssertNil(SpeechModelTransfer(metadata: ["kind": SpeechModelTransfer.kind, "model": "openai_whisper-base.en", "path": "../evil"]))
        XCTAssertNil(SpeechModelTransfer(metadata: ["kind": SpeechModelTransfer.kind, "model": "nope", "path": "tokenizer.json"]))
        XCTAssertNil(SpeechModelTransfer(metadata: WatchVoiceCapture(seconds: 1).metadata))
        XCTAssertNil(WatchVoiceCapture(metadata: t.metadata))
        XCTAssertNil(SpeechModelTransfer(metadata: nil))
    }
}
