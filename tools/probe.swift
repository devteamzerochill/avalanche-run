// Video probe: frame rate, duration, sample frames as PNG, and audio loudness
// per second. Used to check tools/record.swift output.
//   swiftc -O tools/probe.swift -o build/probe
//   build/probe video.mp4 outdir 0.5,10,30
import AVFoundation
import AppKit

let args = CommandLine.arguments
let url = URL(fileURLWithPath: args[1])
let outDir = args.count > 2 ? args[2] : "."
let times = args.count > 3 ? args[3].split(separator: ",").compactMap { Double($0) } : []
let sem = DispatchSemaphore(value: 0)

Task {
  let asset = AVURLAsset(url: url)
  let dur = try await asset.load(.duration).seconds
  let vt = try await asset.loadTracks(withMediaType: .video).first!
  let fps = try await vt.load(.nominalFrameRate)
  let size = try await vt.load(.naturalSize)
  // Count frames exactly.
  let r = try AVAssetReader(asset: asset)
  let o = AVAssetReaderTrackOutput(track: vt, outputSettings: nil)
  r.add(o)
  r.startReading()
  var n = 0
  while let s = o.copyNextSampleBuffer() { if CMSampleBufferGetNumSamples(s) > 0 { n += 1 } }
  print(String(format: "duration %.3f s  %d frames  nominal %.2f fps  %dx%d", dur, n, fps, Int(size.width), Int(size.height)))

  let gen = AVAssetImageGenerator(asset: asset)
  gen.requestedTimeToleranceBefore = .zero
  gen.requestedTimeToleranceAfter = .zero
  for t in times {
    let (cg, _) = try await gen.image(at: CMTime(seconds: t, preferredTimescale: 600))
    let rep = NSBitmapImageRep(cgImage: cg)
    let png = rep.representation(using: .png, properties: [:])!
    let p = "\(outDir)/frame_\(String(format: "%05.2f", t)).png"
    try png.write(to: URL(fileURLWithPath: p))
    print("wrote \(p)")
  }

  if let at = try await asset.loadTracks(withMediaType: .audio).first {
    let ar = try AVAssetReader(asset: asset)
    let ao = AVAssetReaderTrackOutput(track: at, outputSettings: [
      AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
    ])
    ar.add(ao)
    ar.startReading()
    var sum = 0.0
    var cnt = 0
    var sec = 0
    var line = "audio rms/s:"
    while let s = ao.copyNextSampleBuffer() {
      guard let bb = CMSampleBufferGetDataBuffer(s) else { continue }
      var len = 0
      var ptr: UnsafeMutablePointer<Int8>?
      CMBlockBufferGetDataPointer(bb, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &len, dataPointerOut: &ptr)
      let samples = UnsafeRawPointer(ptr!).assumingMemoryBound(to: Int16.self)
      for i in 0..<(len / 2) {
        let v = Double(samples[i]) / 32768
        sum += v * v
        cnt += 1
        if cnt == 88200 {
          line += String(format: " %d:%.3f", sec, (sum / Double(cnt)).squareRoot())
          sec += 1
          sum = 0
          cnt = 0
        }
      }
    }
    print(line)
  }
  sem.signal()
}
sem.wait()
