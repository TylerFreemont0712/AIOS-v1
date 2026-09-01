// The microphone tap that feeds the streaming recogniser.
//
// This exists because an AnalyserNode cannot do it. The level meter next door reads
// the analyser once per animation frame, which is a *snapshot* — whatever the mic did
// between two frames is simply not in it. That is fine for drawing a bar and useless
// for recognition, where dropping 80% of the audio drops most of the words.
//
// An AudioWorkletProcessor is the only node that sees every sample. It runs on the
// audio thread, so the rule here is: touch nothing, allocate nothing per block, and
// hand the samples straight over. All the real work (resampling, batching, shipping)
// happens on the main thread, where being late costs a few milliseconds of latency
// rather than an audible glitch in the capture graph.
//
// MediaRecorder is still running in parallel for the final utterance — this tap is
// purely additive, and if it fails the recording is unaffected.

class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = true;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.on = false; };
  }

  // One output, left silent. It exists only so the node has somewhere to send to:
  // the graph is rendered by pulling from the destination, and a node nothing pulls
  // from is never run at all. The caller mutes the path with a zero gain.
  process(inputs) {
    // inputs[0][0] is 128 mono samples at the context's rate. It is absent while the
    // graph is still connecting, which is normal and not an error.
    const ch = inputs[0]?.[0];
    if (this.on && ch && ch.length) {
      // Copied, not passed: the runtime reuses this buffer for the next block, so
      // handing the view itself across would deliver whatever comes next instead.
      this.port.postMessage(new Float32Array(ch));
    }
    return this.on;
  }
}

registerProcessor('pcm-tap', PcmTap);
