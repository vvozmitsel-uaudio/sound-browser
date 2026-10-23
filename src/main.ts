// Sound Browser: DOM wiring. Connects to LUNA, follows the focused session, searches Freesound,
// auditions previews, and imports a sound (or a file dropped on the page) onto the timeline at
// the playhead. Engine work lives in logic.ts, Freesound in freesound.ts.
//
// npm run build bundles this file and everything it imports into dist/main.js, one classic
// script (an IIFE) that index.html loads after vendor/luna.global.js.

import {
  attribution, FreesoundClient, FreesoundError, SECRET_NAME,
  type LicenseFilter, type SearchParams, type Sound, type SortOrder,
} from './freesound';
import {
  addCredit, creditsText, durationText, focusedTarget, importAudio, positionText, safeFileName, targetSampleRate,
  type Credit, type Target,
} from './logic';
import { encodeWav, isLosslessContainer } from './wav';

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`index.html has no #${id}`);
  return el as T;
}

const APPLY_URL = 'https://freesound.org/apiv2/apply';

let luna: Luna.Client;
let session: Luna.Session | undefined;
let apiKey: string | null = null;
let sampleRate = 48000;
let releases: Luna.Unsubscribe[] = [];
const keep = (u: Luna.Unsubscribe): void => void releases.push(u);
const release = (): void => {
  for (const u of releases) u();
  releases = [];
};

const freesound = new FreesoundClient(() => apiKey);
let lastSearch: SearchParams | undefined;
let searchAbort: AbortController | undefined;
let busy = false;

// ---------------------------------------------------------------------------------------------
// Status line and progress

function status(text: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
  const el = $('status');
  el.textContent = text;
  el.dataset.kind = kind;
}

function progress(fraction: number | undefined): void {
  const bar = $<HTMLProgressElement>('progress');
  bar.hidden = fraction === undefined;
  if (fraction !== undefined) bar.value = fraction;
}

function errorText(e: unknown): string {
  if (e instanceof FreesoundError) return e.message;
  const err = e as { code?: string; message?: string };
  return err?.code && !String(err.message).includes(err.code) ? `${err.message} (${err.code})` : String(err?.message ?? e);
}

/** Open a link in the user's browser: through LUNA when it has a UI, else a new window. */
async function openExternal(url: string): Promise<void> {
  try {
    if (luna && (await luna.gui.available())) return void (await luna.gui.openUrl(url));
  } catch { /* fall back */ }
  window.open(url, '_blank', 'noopener');
}

// ---------------------------------------------------------------------------------------------
// Settings: the API key lives in luna.secrets (the OS keychain inside LUNA), never web storage.

function renderKeyState(): void {
  $('key-state').textContent = apiKey ? 'API key saved' : 'No API key';
  $('key-state').dataset.kind = apiKey ? 'ok' : 'error';
  $<HTMLButtonElement>('search-go').disabled = !apiKey;
  $('storage-note').textContent = luna?.secrets.storage === 'memory'
    ? 'Outside LUNA the key is kept only until this page reloads.'
    : 'Stored in your macOS keychain, readable only by this Add On.';
}

function openSettings(): void {
  $<HTMLInputElement>('key-input').value = '';
  $('key-msg').textContent = '';
  $<HTMLDialogElement>('settings').showModal();
  $<HTMLInputElement>('key-input').focus();
}

async function saveKey(): Promise<void> {
  const input = $<HTMLInputElement>('key-input');
  const key = input.value.trim();
  const msg = $('key-msg');
  if (!key) return void (msg.textContent = 'Paste a key first.');
  msg.textContent = 'Checking with Freesound…';
  try {
    if (!(await freesound.checkKey(key))) return void (msg.textContent = 'Freesound refused that key.');
    await luna.secrets.set(SECRET_NAME, key);
    apiKey = key;
    input.value = '';
    renderKeyState();
    $<HTMLDialogElement>('settings').close();
    status('API key saved. Search away.', 'ok');
    $<HTMLInputElement>('q').focus();
  } catch (e) {
    msg.textContent = errorText(e);
  }
}

async function removeKey(): Promise<void> {
  await luna.secrets.delete(SECRET_NAME);
  apiKey = null;
  renderKeyState();
  $('key-msg').textContent = 'Key removed.';
}

// ---------------------------------------------------------------------------------------------
// Search and results

function readSearch(page = 1): SearchParams {
  const n = (id: string) => {
    const v = $<HTMLInputElement>(id).value.trim();
    return v === '' ? undefined : Number(v);
  };
  return {
    query: $<HTMLInputElement>('q').value,
    minDuration: n('min-dur'),
    maxDuration: n('max-dur'),
    minBpm: n('min-bpm'),
    maxBpm: n('max-bpm'),
    license: $<HTMLSelectElement>('license').value as LicenseFilter,
    sort: $<HTMLSelectElement>('sort').value as SortOrder,
    page,
    pageSize: 30,
  };
}

async function search(params: SearchParams): Promise<void> {
  if (!apiKey) return openSettings();
  searchAbort?.abort();
  const abort = (searchAbort = new AbortController());
  status(params.query.trim() ? `Searching for "${params.query.trim()}"…` : 'Searching…');
  try {
    const page = await freesound.search(params, abort.signal);
    if (abort.signal.aborted) return;
    lastSearch = params;
    renderResults(page.results);
    $<HTMLButtonElement>('prev').disabled = !page.hasPrevious;
    $<HTMLButtonElement>('next').disabled = !page.hasNext;
    $('page').textContent = page.count ? `Page ${page.page} · ${page.count.toLocaleString()} sounds` : '';
    status(page.count ? `${page.count.toLocaleString()} sounds` : 'Nothing found. Loosen the filters?', page.count ? 'ok' : 'info');
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    status(errorText(e), 'error');
    if (e instanceof FreesoundError && e.code === 'bad_key') openSettings();
  }
}

// One shared <audio> for previews; the row that is playing shows it.
const player = new Audio();
let playingId: number | undefined;
player.onended = () => setPlaying(undefined);
player.onerror = () => { if (playingId !== undefined) status('That preview would not play.', 'error'); setPlaying(undefined); };

function setPlaying(id: number | undefined): void {
  playingId = id;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.row .play')) {
    const on = Number(b.dataset.id) === id;
    b.classList.toggle('on', on);
    b.textContent = on ? '■' : '▶';
    b.title = on ? 'Stop preview' : 'Preview';
  }
}

function audition(sound: Sound): void {
  if (playingId === sound.id) {
    player.pause();
    return setPlaying(undefined);
  }
  player.src = sound.previewUrl;
  void player.play().catch((e) => status(`Preview: ${errorText(e)}`, 'error'));
  setPlaying(sound.id);
}

function renderResults(sounds: Sound[]): void {
  const list = $('results');
  list.replaceChildren();
  player.pause();
  setPlaying(undefined);
  if (!sounds.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No sounds on this page.';
    list.append(empty);
    return;
  }
  const tpl = $<HTMLTemplateElement>('row');
  for (const s of sounds) {
    const row = (tpl.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
    const q = <T extends HTMLElement>(sel: string) => row.querySelector(sel) as T;
    const play = q<HTMLButtonElement>('.play');
    play.dataset.id = String(s.id);
    play.onclick = () => audition(s);
    const wave = q<HTMLImageElement>('.wave');
    if (s.waveformUrl) wave.src = s.waveformUrl;
    else wave.remove();
    wave.onclick = () => audition(s);
    const name = q<HTMLAnchorElement>('.name');
    name.textContent = s.name;
    name.href = s.url;
    name.onclick = (e) => { e.preventDefault(); void openExternal(s.url); };
    q('.user').textContent = `by ${s.username}`;
    const facts = [durationText(s.duration), s.channels === 1 ? 'mono' : s.channels ? 'stereo' : '', s.bpm ? `${s.bpm} BPM` : '', s.tonality ?? ''];
    q('.facts').textContent = facts.filter(Boolean).join(' · ');
    const lic = q('.license');
    lic.textContent = s.license;
    lic.dataset.license = s.license;
    q('.tags').textContent = s.tags.slice(0, 8).join(' ');
    const add = q<HTMLButtonElement>('.import');
    add.onclick = () => void importSound(s, add);
    list.append(row);
  }
  syncImportButtons();
  list.scrollTop = 0;
}

// ---------------------------------------------------------------------------------------------
// Import

function target(): Target {
  return $<HTMLSelectElement>('target').value === 'focused' ? { kind: 'focused' } : { kind: 'new' };
}

function syncImportButtons(): void {
  const why = !session ? 'Open a session in LUNA first' : busy ? 'Another import is running' : '';
  for (const b of document.querySelectorAll<HTMLButtonElement>('.row .import, #choose')) {
    b.disabled = !!why;
    b.title = why || (b.id === 'choose' ? 'Import an audio file from disk' : 'Download the preview and put it at the playhead');
  }
  $('drop').classList.toggle('disabled', !!why);
}

function renderTarget(): void {
  const opt = $<HTMLSelectElement>('target').querySelector<HTMLOptionElement>('option[value="focused"]')!;
  const f = session && focusedTarget(session);
  opt.textContent = f ? `Focused track: ${f.name}` : 'Focused track (none)';
  opt.disabled = !f;
  if (!f && $<HTMLSelectElement>('target').value === 'focused') $<HTMLSelectElement>('target').value = 'new';
}

/** Decode any audio the page's WebAudio can read, at the rate LUNA runs. */
async function decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  return ctx.decodeAudioData(bytes.slice(0)); // decodeAudioData detaches its argument
}

/** Planar channels to write: one for mono, else the first two. */
function channelsOf(buffer: AudioBuffer, mono: boolean): Float32Array[] {
  const n = mono ? 1 : Math.min(2, buffer.numberOfChannels);
  return Array.from({ length: n }, (_, c) => buffer.getChannelData(c));
}

/** Run one import with the status line and progress bar; one at a time. */
async function runImport(label: string, work: () => Promise<string>): Promise<void> {
  if (!session || busy) return;
  busy = true;
  syncImportButtons();
  progress(0);
  try {
    status(await work(), 'ok');
  } catch (e) {
    status(`${label}: ${errorText(e)}`, 'error');
  } finally {
    busy = false;
    progress(undefined);
    syncImportButtons();
  }
}

async function importSound(sound: Sound, button?: HTMLButtonElement): Promise<void> {
  const s = session;
  if (!s) return;
  await runImport(`Import "${sound.name}"`, async () => {
    button?.classList.add('working');
    try {
      status(`Downloading "${sound.name}"…`);
      const mp3 = await freesound.preview(sound);
      status(`Decoding "${sound.name}"…`);
      const buffer = await decode(mp3);
      const wav = encodeWav(channelsOf(buffer, sound.channels === 1), buffer.sampleRate);
      const clipName = sound.name.replace(/\.[a-z0-9]{2,4}$/i, '');
      status(`Uploading "${clipName}" to LUNA…`);
      const result = await importAudio(s, {
        bytes: wav,
        fileName: safeFileName(`${clipName} - ${sound.username} - freesound ${sound.id}`),
        clipName,
        seconds: buffer.duration,
        channels: sound.channels === 1 ? 1 : buffer.numberOfChannels,
        target: target(),
        onProgress: (sent, total) => progress(sent / total),
      });
      remember({ id: sound.id, line: attribution(sound), license: sound.license });
      button?.classList.add('done');
      return `Imported "${clipName}" at ${positionText(s, result.startTick)} on ${result.trackName || 'its track'}. One undo removes it.`;
    } finally {
      button?.classList.remove('working');
    }
  });
}

async function importLocalFile(file: File): Promise<void> {
  const s = session;
  if (!s) return;
  await runImport(`Import ${file.name}`, async () => {
    status(`Reading ${file.name}…`);
    const raw = new Uint8Array(await file.arrayBuffer());
    let buffer: AudioBuffer | undefined;
    try {
      buffer = await decode(raw.buffer.slice(0) as ArrayBuffer);
    } catch {
      if (!isLosslessContainer(raw)) throw new Error('this page cannot decode that file. Try WAV, AIFF, MP3 or M4A.');
    }
    // WAV and AIFF go up untouched, keeping their rate and bit depth; anything else as WAV.
    const lossless = isLosslessContainer(raw);
    const bytes = lossless ? raw : encodeWav(channelsOf(buffer!, false), buffer!.sampleRate);
    const clipName = file.name.replace(/\.[^.]+$/, '');
    status(`Uploading "${clipName}" to LUNA…`);
    const result = await importAudio(s, {
      bytes,
      fileName: lossless ? file.name : safeFileName(clipName),
      clipName,
      seconds: buffer?.duration ?? 0,
      channels: buffer?.numberOfChannels ?? 2,
      target: target(),
      onProgress: (sent, total) => progress(sent / total),
    });
    return `Imported "${clipName}" at ${positionText(s, result.startTick)} on ${result.trackName || 'its track'}. One undo removes it.`;
  });
}

// ---------------------------------------------------------------------------------------------
// Credits: what was imported from Freesound, per session. Web storage is fine here: credits are
// not secret, and each Add On id has its own storage.

let credits: Credit[] = [];
const creditsKey = () => `credits:${session?.uid ?? 'none'}`;

function loadCredits(): void {
  try {
    credits = JSON.parse(localStorage.getItem(creditsKey()) ?? '[]') as Credit[];
  } catch {
    credits = [];
  }
  renderCredits();
}

function remember(credit: Credit): void {
  credits = addCredit(credits, credit);
  try { localStorage.setItem(creditsKey(), JSON.stringify(credits)); } catch { /* storage off: keep in memory */ }
  renderCredits();
}

function renderCredits(): void {
  $('credit-count').textContent = String(credits.length);
  $('credits-text').textContent = creditsText(credits) || 'Sounds you import from Freesound are credited here.';
  const needs = credits.filter((c) => c.license !== 'CC0').length;
  $('credit-note').textContent = needs ? `${needs} need attribution if you publish.` : '';
  $<HTMLButtonElement>('copy-credits').disabled = !credits.length;
}

async function copyCredits(): Promise<void> {
  const text = creditsText(credits);
  try {
    await navigator.clipboard.writeText(text);
    status('Credits copied.', 'ok');
  } catch {
    // No clipboard permission: select the text so Cmd+C copies it.
    const range = document.createRange();
    range.selectNodeContents($('credits-text'));
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    status('Credits selected: press Cmd+C to copy.');
  }
}

// ---------------------------------------------------------------------------------------------
// Session

async function bindSession(): Promise<void> {
  release();
  session = luna.sessions.current();
  if (!session) {
    $('session').textContent = 'No session open';
    renderTarget();
    syncImportButtons();
    loadCredits();
    return;
  }
  const s = session;
  await s.ready();
  if (s !== session) return; // a later bind won
  $('session').textContent = s.name.value ?? s.uid;
  keep(s.name.onChange(() => ($('session').textContent = s.name.value ?? s.uid)));
  keep(s.focusedTrack.onChange(renderTarget));
  renderTarget();
  syncImportButtons();
  loadCredits();
}

// ---------------------------------------------------------------------------------------------
// Wiring

function wire(): void {
  $<HTMLFormElement>('search').onsubmit = (e) => { e.preventDefault(); void search(readSearch(1)); };
  for (const id of ['license', 'sort']) $(id).onchange = () => { if (lastSearch) void search(readSearch(1)); };
  $('prev').onclick = () => lastSearch && void search({ ...lastSearch, page: (lastSearch.page ?? 1) - 1 });
  $('next').onclick = () => lastSearch && void search({ ...lastSearch, page: (lastSearch.page ?? 1) + 1 });

  $('open-settings').onclick = openSettings;
  $<HTMLFormElement>('key-form').onsubmit = (e) => { e.preventDefault(); void saveKey(); };
  $('remove-key').onclick = () => void removeKey();
  $('close-settings').onclick = () => $<HTMLDialogElement>('settings').close();
  $('apply').onclick = (e) => { e.preventDefault(); void openExternal(APPLY_URL); };

  // Files: a drop zone always (in LUNA 3.1.0 and earlier a file input opens nothing), and a
  // file input for LUNAs and browsers where it works.
  const drop = $('drop');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const file = e.dataTransfer?.files[0];
    if (file) void importLocalFile(file);
  };
  // A file dropped anywhere else must not navigate the page away.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  const input = $<HTMLInputElement>('file');
  $('choose').onclick = () => input.click();
  input.onchange = () => {
    const file = input.files?.[0];
    input.value = '';
    if (file) void importLocalFile(file);
  };

  $('copy-credits').onclick = () => void copyCredits();
  $('target').onchange = renderTarget;
}

async function connect(): Promise<void> {
  wire();
  for (;;) {
    try {
      // Inside LUNA the page URL carries ?port=; in a browser this falls back to LUNA on
      // localhost.
      luna = await Luna.connect();
      break;
    } catch (e) {
      $('session').textContent = e instanceof Luna.NotRunning ? 'Waiting for LUNA…' : errorText(e);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  // LUNA's standard undo, redo, play and record keys, for any key this page does not handle.
  // Keys typed into the search fields stay with the page.
  Luna.bindShortcuts(luna);

  apiKey = await luna.secrets.get(SECRET_NAME).catch(() => null);
  renderKeyState();
  if (!apiKey) {
    status('Add your Freesound API key to start searching.');
    openSettings();
  } else {
    status('Ready. Search Freesound above.');
  }
  void targetSampleRate(luna).then((rate) => (sampleRate = rate));

  await luna.sessions.ready();
  luna.sessions.focused.onChange(() => void bindSession());
  luna.sessions.items.onChange(() => void bindSession());
  luna.status.onChange(() => {
    if (luna.status.value === 'disconnected') $('session').textContent = 'Reconnecting…';
    if (luna.status.value === 'connected') void bindSession();
  });
  await bindSession();
}

void connect();
