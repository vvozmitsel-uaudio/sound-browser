// Sound Browser: engine logic that does not touch the DOM, so tests can exercise it against
// Luna.MockEngine.
//
// Everything here takes SDK objects (a Luna.Session) and plain data, and returns plain data or
// performs an engine action. main.ts decodes audio and turns data into DOM.
//
// `Luna` is the global that vendor/luna.global.js defines; tsconfig.json types it through
// "@uaudio/luna-builder-sdk/global". Do not import the SDK here: the page already loads it.

/** Where an imported clip goes. */
export type Target =
  | { kind: 'new'; name?: string }
  | { kind: 'focused' };

export interface ImportRequest {
  /** The file to upload: WAV or AIFF bytes. */
  bytes: Uint8Array | ArrayBuffer | Blob;
  /** File name the source is stored under in the session package. */
  fileName: string;
  /** The clip's (and a new track's) name. */
  clipName: string;
  /** Length in seconds, from the decoded audio; used when LUNA has not measured the source yet. */
  seconds: number;
  /** 1 for mono, 2 or more for stereo. Picks a new track's format. */
  channels: number;
  target: Target;
  /** Defaults to the playhead. */
  startTick?: number;
  onProgress?: (sent: number, total: number) => void;
}

export interface ImportResult {
  sourceUid: string;
  trackUid: string;
  trackName: string;
  startTick: number;
  stopTick: number;
}

/** Where a clip goes: the live playhead while playing, the resting one when stopped. */
export function playheadTick(session: Luna.Session): number {
  const t = session.transport;
  const live = t.playing.value ? t.location.value?.tick : undefined;
  return Math.max(0, Math.round(live ?? t.playStart.value ?? 0));
}

/**
 * The rate to decode previews at: the rate of the first online device LUNA runs, so LUNA has
 * nothing to convert. 48 kHz when no device says.
 */
export async function targetSampleRate(luna: Luna.Client): Promise<number> {
  try {
    await luna.devices.load();
    await luna.devices.membersReady();
    const rate = luna.devices.items.find((d) => d.online.value && (d.sampleRate.value ?? 0) > 0)?.sampleRate.value;
    if (rate) return rate;
  } catch { /* fall through */ }
  return 48000;
}

/** A file name LUNA can store: the sound's name, safe characters only, with an extension. */
export function safeFileName(name: string, ext = 'wav'): string {
  const base = name.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[^\w\- ().]+/g, '_').trim().slice(0, 80) || 'sound';
  return `${base}.${ext}`;
}

/** The track a clip lands on when the target is the focused track, or undefined for none. */
export function focusedTarget(session: Luna.Session): { uid: string; name: string } | undefined {
  const t = session.focusedTrack.value;
  return t ? { uid: t.id, name: t.name.value ?? t.id } : undefined;
}

/**
 * Upload the bytes as a source, then put them on the timeline at `startTick` (the playhead by
 * default) as one undo entry: the new track, if any, and the clip. The upload itself is not
 * an undoable edit in LUNA: it adds a source to the session package.
 */
export async function importAudio(session: Luna.Session, req: ImportRequest): Promise<ImportResult> {
  await session.ready();
  const focused = req.target.kind === 'focused' ? focusedTarget(session) : undefined;
  if (req.target.kind === 'focused' && !focused) throw new Error('No track is focused in LUNA. Select a track, or import to a new track.');

  const source = await session.uploadFile({ bytes: req.bytes, name: req.fileName, onProgress: req.onProgress });

  const measured = source.length.value ?? 0;
  const lengthNs = measured > 0 ? measured : Math.round(req.seconds * 1e9);
  const timeline = session.musical.timeline;
  const startTick = Math.max(0, Math.round(req.startTick ?? playheadTick(session)));
  // The exact span for an unstretched source, walked through the tempo map.
  const stopTick = Math.round(timeline.tickAtSeconds(timeline.seconds(startTick) + lengthNs / 1e9));
  if (!(stopTick > startTick)) throw new Error(`"${req.clipName}" has no length to place.`);

  const placed = await session.transaction(`Import ${req.clipName}`, async () => {
    let trackUid = focused?.uid;
    let trackName = focused?.name ?? '';
    if (req.target.kind === 'new') {
      trackName = req.target.name ?? req.clipName;
      const reply = (await session.newTrack({
        name: trackName,
        trackType: 'audio',
        stemFormat: req.channels > 1 ? 'stereo' : 'mono',
        makeNameUnique: true,
      })) as { track_uid?: string; uid?: string } | null;
      trackUid = reply?.track_uid ?? reply?.uid;
      if (!trackUid) throw new Error('LUNA made the track but did not say its uid.');
    }
    await session.insertClip({
      trackUid: trackUid!,
      sourceUid: source.id,
      startTick,
      stopTick,
      sourceStartNs: 0,
      sourceStopNs: lengthNs,
      name: req.clipName,
    });
    return { trackUid: trackUid!, trackName };
  });

  return { sourceUid: source.id, ...placed, startTick, stopTick };
}

/** Position text for a status line: LUNA's bar|beat|tick. */
export function positionText(session: Luna.Session, tick: number): string {
  return session.musical.timeline.formatBarBeat(tick);
}

/** A credit kept for each Freesound sound imported, for the attribution list. */
export interface Credit {
  id: number;
  line: string;
  license: string;
}

/** Add a credit unless the same sound is already credited; returns the new list. */
export function addCredit(credits: Credit[], credit: Credit): Credit[] {
  return credits.some((c) => c.id === credit.id) ? credits : [...credits, credit];
}

/** The credits as text to paste into liner notes or a video description. */
export function creditsText(credits: Credit[]): string {
  if (!credits.length) return '';
  return ['Sounds from Freesound (freesound.org):', ...credits.map((c) => `- ${c.line}`)].join('\n');
}

/** Seconds for result rows: 0.42 s under ten seconds, m:ss.s above. */
export function durationText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  if (seconds < 10) return `${seconds.toFixed(2)} s`;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
