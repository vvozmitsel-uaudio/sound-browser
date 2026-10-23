// Freesound APIv2 client: search and preview downloads, with no DOM and no SDK, so tests can
// run it against a fake fetch.
//
// Auth is the API key ("token") passed as a query parameter. A query parameter keeps every
// request a simple GET, so the browser sends no CORS preflight; Freesound answers
// `Access-Control-Allow-Origin: *` on both the API and the preview CDN.
//
// Only previews (HQ mp3, about 128 kbps) are fetched: they need just the key. Original-quality
// downloads need OAuth2 and are not used here.

export const API_ROOT = 'https://freesound.org/apiv2';

/** The name the key is stored under in luna.secrets. */
export const SECRET_NAME = 'freesound.api_key';

/** Fields asked for in every search: what a result row shows and what an import needs. */
export const SEARCH_FIELDS = [
  'id', 'name', 'username', 'license', 'url', 'duration', 'channels', 'samplerate',
  'tags', 'previews', 'images', 'bpm', 'tonality',
].join(',');

export type LicenseFilter = 'any' | 'cc0' | 'by' | 'by-nc';

export type SortOrder =
  | 'score' | 'downloads_desc' | 'rating_desc' | 'created_desc' | 'duration_asc' | 'duration_desc';

export interface SearchParams {
  query: string;
  /** Seconds; either end may be left out. */
  minDuration?: number;
  maxDuration?: number;
  minBpm?: number;
  maxBpm?: number;
  license?: LicenseFilter;
  sort?: SortOrder;
  page?: number;
  pageSize?: number;
}

/** A sound as the Add On uses it. */
export interface Sound {
  id: number;
  name: string;
  username: string;
  /** Short label: CC0, CC BY, CC BY-NC, or what Freesound sent when unrecognised. */
  license: string;
  licenseUrl: string;
  /** The sound's page on freesound.org, for attribution. */
  url: string;
  duration: number;
  channels?: number;
  sampleRate?: number;
  tags: string[];
  previewUrl: string;
  waveformUrl?: string;
  bpm?: number;
  tonality?: string;
}

export interface SearchPage {
  count: number;
  page: number;
  hasNext: boolean;
  hasPrevious: boolean;
  results: Sound[];
}

export type FreesoundErrorCode = 'no_key' | 'bad_key' | 'rate_limited' | 'http' | 'network';

export class FreesoundError extends Error {
  constructor(readonly code: FreesoundErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = 'FreesoundError';
  }
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

const LICENSE_QUERY: Record<Exclude<LicenseFilter, 'any'>, string> = {
  cc0: 'license:"Creative Commons 0"',
  by: 'license:"Attribution"',
  'by-nc': 'license:"Attribution NonCommercial"',
};

/** A Solr range, or undefined when neither end is a number. */
function range(field: string, min?: number, max?: number): string | undefined {
  const lo = Number.isFinite(min) ? String(min) : '*';
  const hi = Number.isFinite(max) ? String(max) : '*';
  return lo === '*' && hi === '*' ? undefined : `${field}:[${lo} TO ${hi}]`;
}

/** The `filter` parameter for a search, or '' for none. */
export function buildFilter(p: SearchParams): string {
  const parts = [range('duration', p.minDuration, p.maxDuration), range('bpm', p.minBpm, p.maxBpm)];
  if (p.license && p.license !== 'any') parts.push(LICENSE_QUERY[p.license]);
  return parts.filter(Boolean).join(' ');
}

/** The full search URL, key included. */
export function searchUrl(p: SearchParams, key: string): string {
  const q = new URLSearchParams({
    query: p.query.trim(),
    fields: SEARCH_FIELDS,
    page: String(p.page ?? 1),
    page_size: String(Math.min(150, Math.max(1, p.pageSize ?? 30))),
    sort: p.sort ?? 'score',
    token: key,
  });
  const filter = buildFilter(p);
  if (filter) q.set('filter', filter);
  return `${API_ROOT}/search/?${q}`;
}

/** Freesound's license (a Creative Commons URL, or a name) as a short label. */
export function licenseLabel(license: string): string {
  const l = license.toLowerCase();
  if (l.includes('publicdomain/zero') || l.includes('creative commons 0')) return 'CC0';
  if (l.includes('sampling+') || l.includes('sampling-plus')) return 'Sampling+';
  if (l.includes('by-nc') || l.includes('noncommercial')) return 'CC BY-NC';
  if (l.includes('/by/') || l === 'attribution') return 'CC BY';
  return license;
}

/** One credit line, in the form Creative Commons asks for: title, author, source, license. */
export function attribution(s: Pick<Sound, 'name' | 'username' | 'url' | 'license' | 'licenseUrl'>): string {
  return `"${s.name}" by ${s.username} (${s.url}), ${s.license}${s.licenseUrl.startsWith('http') ? ` (${s.licenseUrl})` : ''}`;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** A raw Freesound sound object as a Sound, or undefined when it has no preview to import. */
export function parseSound(raw: Record<string, unknown>): Sound | undefined {
  const previews = (raw.previews ?? {}) as Record<string, string>;
  const images = (raw.images ?? {}) as Record<string, string>;
  const previewUrl = previews['preview-hq-mp3'] ?? previews['preview-lq-mp3'];
  if (typeof raw.id !== 'number' || !previewUrl) return undefined;
  const license = String(raw.license ?? '');
  return {
    id: raw.id,
    name: String(raw.name ?? `Sound ${raw.id}`),
    username: String(raw.username ?? 'unknown'),
    license: licenseLabel(license),
    licenseUrl: license,
    url: String(raw.url ?? `https://freesound.org/s/${raw.id}/`),
    duration: num(raw.duration) ?? 0,
    channels: num(raw.channels),
    sampleRate: num(raw.samplerate),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    previewUrl,
    waveformUrl: images.waveform_m ?? images.waveform_l,
    bpm: num(raw.bpm),
    tonality: typeof raw.tonality === 'string' && raw.tonality ? raw.tonality : undefined,
  };
}

export class FreesoundClient {
  constructor(
    private readonly getKey: () => string | null | undefined,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {}

  private key(): string {
    const key = this.getKey()?.trim();
    if (!key) throw new FreesoundError('no_key', 'Add your Freesound API key in Settings first.');
    return key;
  }

  private async request(url: string, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new FreesoundError('network', `Could not reach Freesound: ${(e as Error).message}`);
    }
    if (res.ok) return res;
    if (res.status === 401 || res.status === 403) throw new FreesoundError('bad_key', 'Freesound refused the API key. Check it in Settings.', res.status);
    if (res.status === 429) throw new FreesoundError('rate_limited', 'Freesound rate limit reached. Wait a minute and try again.', res.status);
    let detail = '';
    try {
      const body = (await res.json()) as { detail?: string };
      detail = body.detail ? `: ${body.detail}` : '';
    } catch { /* not JSON */ }
    throw new FreesoundError('http', `Freesound answered ${res.status}${detail}`, res.status);
  }

  async search(p: SearchParams, signal?: AbortSignal): Promise<SearchPage> {
    const res = await this.request(searchUrl(p, this.key()), signal);
    const body = (await res.json()) as { count?: number; next?: string | null; previous?: string | null; results?: Record<string, unknown>[] };
    return {
      count: body.count ?? 0,
      page: p.page ?? 1,
      hasNext: !!body.next,
      hasPrevious: !!body.previous,
      results: (body.results ?? []).map(parseSound).filter((s): s is Sound => !!s),
    };
  }

  /** Check a key with the cheapest search there is. Resolves true, or false for a refused key. */
  async checkKey(key: string): Promise<boolean> {
    const probe = new FreesoundClient(() => key, this.fetchImpl);
    try {
      await probe.search({ query: 'kick', pageSize: 1 });
      return true;
    } catch (e) {
      if (e instanceof FreesoundError && e.code === 'bad_key') return false;
      throw e;
    }
  }

  /** The preview's encoded bytes (mp3). Previews are public on Freesound's CDN. */
  async preview(sound: Sound, signal?: AbortSignal): Promise<ArrayBuffer> {
    const res = await this.request(sound.previewUrl, signal);
    return res.arrayBuffer();
  }
}
