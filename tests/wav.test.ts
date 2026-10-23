import { describe, expect, it } from 'vitest';
import { encodeWav, isLosslessContainer } from '../src/wav';

const tag = (b: Uint8Array, at: number) => String.fromCharCode(...b.subarray(at, at + 4));

describe('encodeWav', () => {
  it('writes a 24-bit stereo header and interleaved samples', () => {
    const wav = encodeWav([new Float32Array([0, 1, -1]), new Float32Array([0.5, 0, 2])], 48000);
    const v = new DataView(wav.buffer);
    expect(tag(wav, 0)).toBe('RIFF');
    expect(tag(wav, 8)).toBe('WAVE');
    expect(v.getUint32(4, true)).toBe(wav.length - 8);
    expect(v.getUint16(20, true)).toBe(1);        // PCM
    expect(v.getUint16(22, true)).toBe(2);        // channels
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint32(28, true)).toBe(48000 * 6);
    expect(v.getUint16(32, true)).toBe(6);
    expect(v.getUint16(34, true)).toBe(24);
    expect(v.getUint32(40, true)).toBe(3 * 6);
    const s24 = (at: number) => (wav[at] | (wav[at + 1] << 8) | (wav[at + 2] << 16)) << 8 >> 8;
    // frame 0: L 0, R 0.5; frame 1: L 1, R 0; frame 2: L -1, R 2 (clipped to 1)
    expect([0, 3, 6, 9, 12, 15].map((i) => s24(44 + i))).toEqual([0, 4194304, 8388607, 0, -8388607, 8388607]);
  });

  it('writes 16-bit mono', () => {
    const wav = encodeWav([new Float32Array([1, -0.5])], 44100, 16);
    const v = new DataView(wav.buffer);
    expect(wav.length).toBe(44 + 4);
    expect(v.getUint16(34, true)).toBe(16);
    expect([v.getInt16(44, true), v.getInt16(46, true)]).toEqual([32767, -16383]); // symmetric scale; Math.round(-16383.5) is -16383
  });

  it('refuses no channels or ragged ones', () => {
    expect(() => encodeWav([], 48000)).toThrow();
    expect(() => encodeWav([new Float32Array(2), new Float32Array(3)], 48000)).toThrow();
  });
});

describe('isLosslessContainer', () => {
  it('knows WAV and AIFF from their headers', () => {
    expect(isLosslessContainer(encodeWav([new Float32Array(4)], 48000))).toBe(true);
    const aiff = new Uint8Array(12);
    aiff.set([...'FORM'].map((c) => c.charCodeAt(0)), 0);
    aiff.set([...'AIFF'].map((c) => c.charCodeAt(0)), 8);
    expect(isLosslessContainer(aiff)).toBe(true);
    expect(isLosslessContainer(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false); // ID3 (mp3)
    expect(isLosslessContainer(new Uint8Array(3))).toBe(false);
  });
});
