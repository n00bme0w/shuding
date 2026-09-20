class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.position = 0;
    this.samples = [];
    this.port.onmessage = () => this.flush();
  }

  flush() {
    if (this.samples.length === 0) return;
    const chunk = new Float32Array(this.samples.splice(0));
    this.port.postMessage(chunk, [chunk.buffer]);
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let index = this.position; index < input.length; index += this.ratio) {
      this.samples.push(input[Math.floor(index)] ?? 0);
    }
    this.position -= input.length;
    while (this.position < 0) this.position += this.ratio;
    if (this.samples.length >= 4096) {
      const chunk = new Float32Array(this.samples.splice(0, 4096));
      this.port.postMessage(chunk, [chunk.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
