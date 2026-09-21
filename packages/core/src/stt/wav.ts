/**
 * Utility to prepend a standard 44-byte RIFF/WAVE header to linear PCM audio data.
 * Useful for REST-based STT endpoints (like OpenAI Whisper or Google Cloud Speech)
 * that expect containerized WAV audio instead of raw byte streams.
 */
export function pcmToWav(
  pcmData: Buffer,
  sampleRate = 16000,
  channels = 1,
  bitDepth = 16
): Buffer {
  const byteRate = (sampleRate * channels * bitDepth) / 8;
  const blockAlign = (channels * bitDepth) / 8;
  const header = Buffer.alloc(44);

  // RIFF Chunk Descriptor
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write("WAVE", 8);

  // "fmt " sub-chunk
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  header.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
  header.writeUInt16LE(channels, 22); // NumChannels
  header.writeUInt32LE(sampleRate, 24); // SampleRate
  header.writeUInt32LE(byteRate, 28); // ByteRate
  header.writeUInt16LE(blockAlign, 32); // BlockAlign
  header.writeUInt16LE(bitDepth, 34); // BitsPerSample

  // "data" sub-chunk
  header.write("data", 36);
  header.writeUInt32LE(pcmData.length, 40); // Subchunk2Size

  return Buffer.concat([header, pcmData]);
}
