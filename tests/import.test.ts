// Importing into a session, against Luna.MockEngine: no LUNA needed. tests/setup.ts defines
// the Luna global that src/ reads.
import { describe, expect, it } from 'vitest';
import {
  addCredit, creditsText, durationText, focusedTarget, importAudio, playheadTick, positionText, safeFileName,
} from '../src/logic';
import { encodeWav } from '../src/wav';

async function connected() {
  const engine = new Luna.MockEngine();
  engine.addSession('abc', { name: 'Demo', tracks: ['Vocal', 'Bass'] });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  await session.playlists.load();
  return { engine, luna, session };
}

/** Half a second of stereo silence at 48 kHz, as WAV. */
const wav = () => encodeWav([new Float32Array(24000), new Float32Array(24000)], 48000);

/** Every clip in the session, with the track its playlist belongs to. */
async function clips(engine: Luna.MockEngine) {
  const out: { track: string; name: unknown; start: unknown; stop: unknown; source: unknown }[] = [];
  for (const pl of engine.children('/sessions/abc/playlists')) {
    const track = String(engine.value(`/sessions/abc/playlists/${pl}`, 'track_uid'));
    for (const c of engine.children(`/sessions/abc/playlists/${pl}/clips`)) {
      const at = `/sessions/abc/playlists/${pl}/clips/${c}`;
      out.push({ track, name: engine.value(at, 'name'), start: engine.value(at, 'start'), stop: engine.value(at, 'stop'), source: engine.value(at, 'source_uid') });
    }
  }
  return out;
}

describe('importAudio', () => {
  it('uploads, makes a track and places the clip at the playhead as one undo entry', async () => {
    const { engine, session } = await connected();
    await session.transport.playStart.set(Luna.TICKS_PER_BEAT * 4);
    await engine.settled();
    const progress: number[] = [];

    const result = await importAudio(session, {
      bytes: wav(), fileName: 'Kick.wav', clipName: 'Kick', seconds: 0.5, channels: 2,
      target: { kind: 'new' }, onProgress: (sent, total) => progress.push(sent / total),
    });
    await engine.settled();

    expect(progress.at(-1)).toBe(1);
    expect(engine.transactions).toEqual(['begin', 'commit']);
    const tl = session.musical.timeline;
    expect(result.startTick).toBe(Luna.TICKS_PER_BEAT * 4);
    expect(tl.seconds(result.stopTick) - tl.seconds(result.startTick)).toBeCloseTo(0.5, 6);
    const newTrack = engine.children('/sessions/abc/tracks').find((t) => !['Vocal', 'Bass'].includes(t))!;
    expect(result.trackUid).toBe(newTrack);
    expect(engine.value(`/sessions/abc/tracks/${newTrack}`, 'name')).toBe('Kick');
    expect(engine.value(`/sessions/abc/tracks/${newTrack}`, 'stem_format')).toBe('stereo');
    expect(await clips(engine)).toEqual([{ track: newTrack, name: 'Kick', start: result.startTick, stop: result.stopTick, source: result.sourceUid }]);
    const newTrackPost = engine.requests.find((r) => r.path.endsWith('/new_track'));
    expect(newTrackPost?.data).toMatchObject({ track_type: 'audio', stem_format: 'stereo' });
  });

  it('makes a mono track for mono audio', async () => {
    const { engine, session } = await connected();
    await importAudio(session, { bytes: wav(), fileName: 'a.wav', clipName: 'A', seconds: 0.5, channels: 1, target: { kind: 'new' } });
    expect(engine.requests.find((r) => r.path.endsWith('/new_track'))?.data).toMatchObject({ stem_format: 'mono' });
  });

  it('puts the clip on the focused track without making one', async () => {
    const { engine, session } = await connected();
    const focused = focusedTarget(session)!;
    expect(focused).toEqual({ uid: 'Vocal', name: 'Vocal' });
    const result = await importAudio(session, {
      bytes: wav(), fileName: 'Snare.wav', clipName: 'Snare', seconds: 0.5, channels: 2, target: { kind: 'focused' }, startTick: 0,
    });
    await engine.settled();
    expect(result).toMatchObject({ trackUid: 'Vocal', trackName: 'Vocal', startTick: 0 });
    expect(engine.requests.some((r) => r.path.endsWith('/new_track'))).toBe(false);
    expect((await clips(engine)).map((c) => c.track)).toEqual(['Vocal']);
  });

  it('places nothing when the audio has no length', async () => {
    const { engine, session } = await connected();
    await expect(importAudio(session, { bytes: wav(), fileName: 'z.wav', clipName: 'Z', seconds: 0, channels: 2, target: { kind: 'new' } }))
      .rejects.toThrow('no length');
    expect(engine.transactions).toEqual([]);
  });

  it('follows the live playhead while playing', async () => {
    const { engine, session } = await connected();
    engine.setValue('/sessions/abc', 'playing', true);
    engine.setValue('/sessions/abc', 'location', { tick: Luna.TICKS_PER_BEAT * 9, bar_beat: { bar: 3, beat: 2, tick: 0 } });
    await engine.settled();
    expect(playheadTick(session)).toBe(Luna.TICKS_PER_BEAT * 9);
    expect(positionText(session, Luna.TICKS_PER_BEAT * 4)).toBe('2|1|000');
  });
});

describe('helpers', () => {
  it('makes safe file names', () => {
    expect(safeFileName('Kick drum 01.wav')).toBe('Kick drum 01.wav');
    expect(safeFileName('a/b:c*?.mp3')).toBe('a_b_c_.wav');
    expect(safeFileName('???')).toBe('_.wav');
    expect(safeFileName('')).toBe('sound.wav');
  });

  it('keeps one credit per sound and formats them', () => {
    let credits = addCredit([], { id: 1, line: '"A" by x', license: 'CC0' });
    credits = addCredit(credits, { id: 1, line: '"A" by x', license: 'CC0' });
    credits = addCredit(credits, { id: 2, line: '"B" by y', license: 'CC BY' });
    expect(creditsText(credits)).toBe('Sounds from Freesound (freesound.org):\n- "A" by x\n- "B" by y');
    expect(creditsText([])).toBe('');
  });

  it('formats durations', () => {
    expect(durationText(0.48)).toBe('0.48 s');
    expect(durationText(75.25)).toBe('1:15.3');
    expect(durationText(NaN)).toBe('-');
  });
});
