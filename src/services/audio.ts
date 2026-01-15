import { ProtectedTinyNotifier } from "../lib/utils/tiny-notifier";

export const SERVER_AUDIO_SAMPLE_RATE = 16_000;

export function* chunkPcmBufferRandomDurations(
  buffer: Buffer,
  spec = { sampleRate: 16000, bitDepth: 16, channels: 1 }
) {
  const bytesPerSample = spec.bitDepth / 8;
  const frameSize = bytesPerSample * spec.channels;

  let offset = 0;

  while (offset < buffer.length) {
    const randomDuration = Math.random() * 0.4 + 0.1; // 0.1–0.5s
    const targetByteLength =
      Math.floor(spec.sampleRate * randomDuration) * frameSize;
    const remainingBytes = buffer.length - offset;
    const actualByteLength = Math.min(targetByteLength, remainingBytes);
    const chunk = buffer.subarray(offset, offset + actualByteLength);
    yield chunk;
    offset += actualByteLength;
  }
}

export function resamplePcmAudioBuffer(
  buffer: Buffer,
  fromSampleRate: number,
  toSampleRate: number
): Buffer {
  const input = new Int16Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.length / 2
  );
  const outputLength = Math.floor(
    (input.length * toSampleRate) / fromSampleRate
  );
  const output = new Int16Array(outputLength);

  const ratio = input.length / outputLength;

  for (let i = 0; i < outputLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;

    const sample1 = input[idx];
    const sample2 = input[Math.min(idx + 1, input.length - 1)];

    output[i] = Math.round(sample1 + (sample2 - sample1) * frac);
  }

  return Buffer.from(output.buffer);
}

export function pcmToWav(
  pcmBuffer: Buffer,
  sampleRate: number,
  numChannels: number
) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * numChannels * 2; // 16-bit 為 2 bytes
  const blockAlign = numChannels * 2;

  // RIFF identifier
  header.write("RIFF", 0);
  // File length (Header 44 bytes - 8 + Data length)
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  // RIFF type
  header.write("WAVE", 8);
  // format chunk identifier
  header.write("fmt ", 12);
  // format chunk length
  header.writeUInt32LE(16, 16);
  // sample format (1 is PCM)
  header.writeUInt16LE(1, 20);
  // channel count
  header.writeUInt16LE(numChannels, 22);
  // sample rate
  header.writeUInt32LE(sampleRate, 24);
  // byte rate
  header.writeUInt32LE(byteRate, 28);
  // block align
  header.writeUInt16LE(blockAlign, 32);
  // bits per sample
  header.writeUInt16LE(16, 34);
  // data chunk identifier
  header.write("data", 36);
  // data chunk length
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}

export function wavToPcm(
  wavBuffer: Buffer,
  outputRate: number,
  outputNumChannels: number
): Buffer {
  if (wavBuffer.length < 44) throw new Error("Invalid WAV: too small");
  if (wavBuffer.toString("ascii", 0, 4) !== "RIFF")
    throw new Error("Invalid WAV: missing RIFF");
  if (wavBuffer.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("Invalid WAV: missing WAVE");

  if (outputNumChannels !== 1 && outputNumChannels !== 2) {
    throw new Error("Only outputNumChannels 1 or 2 is supported");
  }

  // Find fmt/data chunks (supports extra chunks)
  let pos = 12;
  let fmtOffset = -1;
  let fmtSize = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (pos + 8 <= wavBuffer.length) {
    const id = wavBuffer.toString("ascii", pos, pos + 4);
    const size = wavBuffer.readUInt32LE(pos + 4);
    const payload = pos + 8;
    if (payload + size > wavBuffer.length)
      throw new Error("Invalid WAV: chunk exceeds buffer");

    if (id === "fmt ") {
      fmtOffset = payload;
      fmtSize = size;
    } else if (id === "data") {
      dataOffset = payload;
      dataSize = size;
      break; // usually last; enough for PCM extraction
    }

    // chunks are padded to even size
    pos = payload + size + (size & 1);
  }

  if (fmtOffset < 0) throw new Error("Invalid WAV: missing fmt chunk");
  if (dataOffset < 0) throw new Error("Invalid WAV: missing data chunk");
  if (fmtSize < 16) throw new Error("Invalid WAV: fmt chunk too small");

  const audioFormat = wavBuffer.readUInt16LE(fmtOffset + 0);
  const inChannels = wavBuffer.readUInt16LE(fmtOffset + 2);
  const inSampleRate = wavBuffer.readUInt32LE(fmtOffset + 4);
  const bitsPerSample = wavBuffer.readUInt16LE(fmtOffset + 14);

  // Support PCM (1) only (16-bit)
  if (audioFormat !== 1)
    throw new Error(`Unsupported WAV format: ${audioFormat} (only PCM=1)`);
  if (bitsPerSample !== 16)
    throw new Error(`Unsupported bitsPerSample: ${bitsPerSample} (only 16)`);
  if (inChannels < 1) throw new Error("Invalid WAV: channel count");

  const dataEnd = Math.min(wavBuffer.length, dataOffset + dataSize);
  let pcm = wavBuffer.subarray(dataOffset, dataEnd);

  if (pcm.length % (inChannels * 2) !== 0) {
    // allow, but trim to whole frames
    const frameBytes = inChannels * 2;
    pcm = pcm.subarray(0, pcm.length - (pcm.length % frameBytes));
  }

  // Channel conversion (16-bit interleaved)
  const toMono = (): Buffer => {
    if (inChannels === 1) return Buffer.from(pcm);

    const array = new Int16Array(
      pcm.buffer,
      pcm.byteOffset,
      pcm.byteLength / 2
    );
    const frames = array.length / inChannels;
    const out = new Int16Array(frames);

    for (let f = 0; f < frames; f++) {
      let sum = 0;
      const base = f * inChannels;
      for (let c = 0; c < inChannels; c++) sum += array[base + c];
      out[f] = (sum / inChannels) | 0;
    }
    return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  };

  const toStereo = (): Buffer => {
    if (inChannels === 2) return Buffer.from(pcm);

    const array = new Int16Array(
      pcm.buffer,
      pcm.byteOffset,
      pcm.byteLength / 2
    );
    const frames = array.length / inChannels;
    const out = new Int16Array(frames * 2);

    if (inChannels === 1) {
      for (let f = 0; f < frames; f++) {
        const v = array[f];
        out[f * 2] = v;
        out[f * 2 + 1] = v;
      }
      return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
    }

    // inChannels >= 3: take first two channels
    for (let f = 0; f < frames; f++) {
      const base = f * inChannels;
      out[f * 2] = array[base];
      out[f * 2 + 1] = array[base + 1];
    }
    return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  };

  // First convert channels with respect to input channels
  let workingChannels = inChannels;
  if (outputNumChannels === 1) {
    pcm = toMono();
    workingChannels = 1;
  } else {
    // outputNumChannels === 2
    pcm = toStereo();
    workingChannels = 2;
  }

  // Resample (per channel if needed)
  if (outputRate <= 0) throw new Error("Invalid outputRate");
  if (inSampleRate !== outputRate) {
    if (workingChannels === 1) {
      pcm = resamplePcmAudioBuffer(pcm, inSampleRate, outputRate);
    } else {
      // deinterleave -> resample each -> interleave
      const array = new Int16Array(
        pcm.buffer,
        pcm.byteOffset,
        pcm.byteLength / 2
      );
      const frames = array.length / workingChannels;

      const ch0 = Buffer.alloc(frames * 2);
      const ch1 = Buffer.alloc(frames * 2);

      for (let f = 0; f < frames; f++) {
        ch0.writeInt16LE(array[f * 2], f * 2);
        ch1.writeInt16LE(array[f * 2 + 1], f * 2);
      }

      const r0 = resamplePcmAudioBuffer(ch0, inSampleRate, outputRate);
      const r1 = resamplePcmAudioBuffer(ch1, inSampleRate, outputRate);

      const outFrames = Math.min(r0.length, r1.length) / 2;
      const out = Buffer.alloc(outFrames * 2 * 2);

      for (let f = 0; f < outFrames; f++) {
        out.writeInt16LE(r0.readInt16LE(f * 2), f * 4);
        out.writeInt16LE(r1.readInt16LE(f * 2), f * 4 + 2);
      }
      pcm = out;
    }
  }

  return pcm;
}

class AudioNotifier extends ProtectedTinyNotifier<Buffer> {
  constructor() {
    super();
  }

  play(pcm: Buffer) {
    return this.notify(pcm);
  }
}

export const serverMic = new AudioNotifier();
export const serverSpeaker = new AudioNotifier();
