import { describe, expect, it } from 'vitest';
import type { MediaInfo } from './api';
import { infoRows } from './InfoPanel';

const base: MediaInfo = {
  id: 'm', filename: 'x', kind: 'audio', status: 'ready', width: null, height: null, durationMs: 3000, fps: null, sizeBytes: 2048,
  createdAt: 0, container: 'WAV', compression: { codec: 'PCM 16-bit', codecName: 'pcm_s16le', codecLong: null, profile: null, pixFmt: null, bitDepth: null, bitRate: 705600 },
  source: 'Unknown', sourceEvidence: 'no known markers', sampleRate: 44100, channels: 2,
};
const rows = (i: MediaInfo) => Object.fromEntries(infoRows(i));

describe('infoRows', () => {
  it('audio: codec, bitrate, sample rate, channels, padded duration', () => {
    const r = rows(base);
    expect(r['Codec']).toBe('PCM 16-bit · 706 kb/s');
    expect(r['Sample rate']).toBe('44.1 kHz');
    expect(r['Channels']).toBe('Stereo');
    expect(r['Duration']).toBe('0:03.00');
    expect(r['Resolution']).toBeUndefined();
  });
  it('documents: pages for PDF, lines + words for text', () => {
    const pdf = rows({ ...base, kind: 'document', format: 'pdf', pages: 12, durationMs: null, width: 612, height: 792, sampleRate: null, channels: null });
    expect(pdf['Pages']).toBe('12');
    expect(pdf['Format']).toBe('PDF');
    expect(pdf['Resolution']).toBeUndefined();
    const txt = rows({ ...base, kind: 'document', format: 'fountain', lines: 1234, words: 9876, durationMs: null, sampleRate: null, channels: null });
    expect(txt['Lines']).toBe('1,234');
    expect(txt['Words']).toBe('9,876');
    expect(txt['Pages']).toBeUndefined();
    expect(txt['Source']).toBe('Unknown (no known markers)');
  });
});
