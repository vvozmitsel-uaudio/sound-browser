// The Freesound client against a fake fetch: no network, no key needed.
import { describe, expect, it } from 'vitest';
import {
  attribution, buildFilter, FreesoundClient, FreesoundError, licenseLabel, parseSound, searchUrl, SEARCH_FIELDS,
  type FetchLike,
} from '../src/freesound';

const RAW = {
  id: 171104,
  name: 'Kick drum 01.wav',
  username: 'someone',
  license: 'http://creativecommons.org/publicdomain/zero/1.0/',
  url: 'https://freesound.org/people/someone/sounds/171104/',
  duration: 0.48,
  channels: 1,
  samplerate: 44100,
  tags: ['kick', 'drum'],
  previews: { 'preview-hq-mp3': 'https://cdn.freesound.org/previews/171/171104_2394245-hq.mp3', 'preview-lq-mp3': 'lq.mp3' },
  images: { waveform_m: 'https://cdn.freesound.org/displays/171/171104_wave_M.png' },
  bpm: 120,
  tonality: 'C minor',
};

/** A fetch that answers from a function and records every URL asked for. */
function fakeFetch(answer: (url: string) => Response) {
  const urls: string[] = [];
  const f: FetchLike = async (url) => { urls.push(url); return answer(url); };
  return { f, urls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('search URL', () => {
  it('carries the query, fields, page, sort and key', () => {
    const url = new URL(searchUrl({ query: '  kick ', page: 2, pageSize: 20, sort: 'downloads_desc' }, 'KEY'));
    expect(url.origin + url.pathname).toBe('https://freesound.org/apiv2/search/');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: 'kick', fields: SEARCH_FIELDS, page: '2', page_size: '20', sort: 'downloads_desc', token: 'KEY',
    });
  });

  it('caps the page size at 150', () => {
    expect(new URL(searchUrl({ query: 'x', pageSize: 999 }, 'K')).searchParams.get('page_size')).toBe('150');
  });

  it('builds Solr ranges and the license filter', () => {
    expect(buildFilter({ query: '' })).toBe('');
    expect(buildFilter({ query: '', maxDuration: 5 })).toBe('duration:[* TO 5]');
    expect(buildFilter({ query: '', minDuration: 1, maxDuration: 5, minBpm: 90, license: 'cc0' }))
      .toBe('duration:[1 TO 5] bpm:[90 TO *] license:"Creative Commons 0"');
    expect(buildFilter({ query: '', license: 'by-nc' })).toBe('license:"Attribution NonCommercial"');
    expect(buildFilter({ query: '', minBpm: NaN, license: 'any' })).toBe('');
  });
});

describe('sounds', () => {
  it('parses what a row and an import need', () => {
    expect(parseSound(RAW)).toEqual({
      id: 171104,
      name: 'Kick drum 01.wav',
      username: 'someone',
      license: 'CC0',
      licenseUrl: RAW.license,
      url: RAW.url,
      duration: 0.48,
      channels: 1,
      sampleRate: 44100,
      tags: ['kick', 'drum'],
      previewUrl: RAW.previews['preview-hq-mp3'],
      waveformUrl: RAW.images.waveform_m,
      bpm: 120,
      tonality: 'C minor',
    });
  });

  it('drops a sound with no preview, and tolerates missing descriptors', () => {
    expect(parseSound({ id: 1, name: 'x' })).toBeUndefined();
    const s = parseSound({ id: 2, previews: { 'preview-lq-mp3': 'lq.mp3' } })!;
    expect(s).toMatchObject({ previewUrl: 'lq.mp3', bpm: undefined, tonality: undefined, url: 'https://freesound.org/s/2/' });
  });

  it('labels licenses by URL or by name', () => {
    expect(licenseLabel('http://creativecommons.org/licenses/by/4.0/')).toBe('CC BY');
    expect(licenseLabel('https://creativecommons.org/licenses/by-nc/4.0/')).toBe('CC BY-NC');
    expect(licenseLabel('Attribution NonCommercial')).toBe('CC BY-NC');
    expect(licenseLabel('Creative Commons 0')).toBe('CC0');
    expect(licenseLabel('http://creativecommons.org/licenses/sampling+/1.0/')).toBe('Sampling+');
  });

  it('writes a Creative Commons credit line', () => {
    expect(attribution(parseSound(RAW)!)).toBe(
      `"Kick drum 01.wav" by someone (${RAW.url}), CC0 (${RAW.license})`,
    );
  });
});

describe('client', () => {
  it('searches and pages', async () => {
    const { f, urls } = fakeFetch(() => json({ count: 31, next: 'https://next', previous: null, results: [RAW, { id: 9 }] }));
    const page = await new FreesoundClient(() => 'KEY', f).search({ query: 'kick' });
    expect(page).toMatchObject({ count: 31, page: 1, hasNext: true, hasPrevious: false });
    expect(page.results.map((s) => s.id)).toEqual([171104]);
    expect(new URL(urls[0]).searchParams.get('token')).toBe('KEY');
  });

  it('asks for a key before calling Freesound', async () => {
    const { f, urls } = fakeFetch(() => json({}));
    await expect(new FreesoundClient(() => null, f).search({ query: 'x' })).rejects.toMatchObject({ code: 'no_key' });
    await expect(new FreesoundClient(() => '  ', f).search({ query: 'x' })).rejects.toMatchObject({ code: 'no_key' });
    expect(urls).toEqual([]);
  });

  it('names a refused key, the rate limit and other failures', async () => {
    const at = (status: number, body: unknown = { detail: 'nope' }) => new FreesoundClient(() => 'K', fakeFetch(() => json(body, status)).f);
    await expect(at(401).search({ query: 'x' })).rejects.toMatchObject({ code: 'bad_key', status: 401 });
    await expect(at(429).search({ query: 'x' })).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(at(500).search({ query: 'x' })).rejects.toThrow('Freesound answered 500: nope');
    const offline = new FreesoundClient(() => 'K', async () => { throw new TypeError('Load failed'); });
    await expect(offline.search({ query: 'x' })).rejects.toBeInstanceOf(FreesoundError);
  });

  it('checks a key', async () => {
    const client = new FreesoundClient(() => null, fakeFetch((url) => json({ results: [] }, url.includes('token=good') ? 200 : 401)).f);
    expect(await client.checkKey('good')).toBe(true);
    expect(await client.checkKey('bad')).toBe(false);
  });

  it('downloads a preview', async () => {
    const { f, urls } = fakeFetch(() => new Response(new Uint8Array([1, 2, 3])));
    const bytes = await new FreesoundClient(() => 'K', f).preview(parseSound(RAW)!);
    expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3]);
    expect(urls).toEqual([RAW.previews['preview-hq-mp3']]);
  });
});
