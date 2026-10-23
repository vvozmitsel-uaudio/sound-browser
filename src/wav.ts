// PCM WAV encoding for decoded audio. Freesound previews are mp3, and the SDK does not say
// which compressed formats LUNA's import accepts, so the page decodes with WebAudio and sends
// LUNA a 24-bit WAV, which every LUNA reads.

export type BitDepth = 16 | 24;

/** Planar float channels (-1..1, equal lengths) as a RIFF WAVE file. */
export function encodeWav(channels: Float32Array[], sampleRate: number, bitDepth: BitDepth = 24): Uint8Array {
  if (!channels.length) throw new Error('encodeWav: no channels');
  const frames = channels[0].length;
  if (channels.some((c) => c.length !== frames)) throw new Error('encodeWav: channels differ in length');
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels.length * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);              // fmt chunk size
  view.setUint16(20, 1, true);               // PCM
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  const max = 2 ** (bitDepth - 1) - 1;
  let at = 44;
  for (let f = 0; f < frames; f++) {
    for (const ch of channels) {
      const s = Math.round(Math.max(-1, Math.min(1, ch[f])) * max);
      if (bitDepth === 16) {
        view.setInt16(at, s, true);
      } else {
        out[at] = s & 0xff;
        out[at + 1] = (s >> 8) & 0xff;
        out[at + 2] = (s >> 16) & 0xff;
      }
      at += bytesPerSample;
    }
  }
  return out;
}

/** True for bytes that already are a WAV or AIFF file, which LUNA reads as they are. */
export function isLosslessContainer(bytes: Uint8Array): boolean {
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12) return false;
  return (tag(0) === 'RIFF' && tag(8) === 'WAVE') || (tag(0) === 'FORM' && (tag(8) === 'AIFF' || tag(8) === 'AIFC'));
}
