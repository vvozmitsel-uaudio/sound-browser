# Sound Browser

A [LUNA](https://www.uaudio.com/luna) Add On that searches [Freesound](https://freesound.org)'s
600,000+ Creative Commons sounds from a window inside LUNA. You can preview a sound and import
it at the playhead without leaving your session.

> Sound Browser is a community project. It is not made or supported by Universal Audio or
> Freesound.

## Features

- **Search** Freesound by keyword. Filter by length, BPM and license (CC0, CC BY, CC BY-NC),
  and sort by relevance, downloads, rating, newest or length.
- **Preview** any result with one click. Each result shows its waveform, author, length, BPM
  and key.
- **Import** a sound at the playhead, onto a new track or the focused track. The new track and
  clip are a single undo step, so ⌘Z removes both.
- **Drop your own files** (WAV, AIFF, MP3, M4A) on the window to place them the same way.
- **Credits:** every Freesound sound you import is listed per session with its author, link and
  license. A Copy button gives you the list for liner notes or video descriptions.

## Install

1. You need **LUNA 3.1.1 or newer**.
2. Download `sound-browser.lunaaddon` from the [latest release](../../releases/latest) and
   double-click it. LUNA installs it.
3. Open it from **Add Ons > Windows > Sound Browser**.
4. Get a free Freesound API key at <https://freesound.org/apiv2/apply>: sign in, create a
   credential, and copy its API key. Paste it into the Add On's **Settings**.

The key is checked with Freesound, then saved in your system keychain through LUNA, where
only this Add On can read it. It is never written to web storage or to the Add On's files.

## Good to know

- **Audio quality.** Imports use Freesound's high-quality previews (about 128 kbps MP3). The
  Add On decodes them at your audio device's sample rate and imports a 24-bit WAV.
  Full-quality original files need Freesound's OAuth2 login and are not supported yet.
- **Licenses.** Each sound has its own license, shown as a badge on every result. CC0 is free
  to use, **CC BY requires credit**, and **CC BY-NC can't be used commercially**. The Credits
  panel keeps the attribution lines for you.
- **Your own files.** WAV and AIFF go in unchanged. Other formats are decoded in the page and
  imported as WAV. In LUNA 3.1.0 and earlier the file picker opens nothing, so use the drop
  zone there.

## Build from source

Sound Browser is TypeScript, built with [Vite](https://vite.dev) into one classic script, on the
LUNA Builder SDK (`@uaudio/luna-builder-sdk`). The SDK is not on npm: you need a copy of it,
and `package.json` must point to that copy. Edit the `file:` path under `devDependencies`
to match where your copy is.

```sh
npm install --ignore-scripts   # the SDK ships prebuilt; skip its own build step
cp "<path to SDK>/dist/luna.global.js" vendor/   # the SDK bundle the page loads
npm test                       # unit tests against the SDK's mock engine and a fake Freesound
npm run build                  # type-check, then src/ -> dist/main.js
npx ua-builder serve           # http://localhost:8790/ (LUNA running = live data)
npm run test:page              # with serve running: the page end to end in headless Chrome
npx ua-builder install         # link this folder into LUNA's Add Ons folder
npm run pack                   # build, then sound-browser.lunaaddon for a release
```

`install` links this folder, so LUNA loads whatever `dist/` holds. Build first, or keep
`npm run dev` running, and reopen the Add On after a rebuild.

| Path | Purpose |
|---|---|
| `manifest.json` | What LUNA reads: id, name, window size, entry page. |
| `index.html` | The page and its styles. Loads `vendor/luna.global.js`, then `dist/main.js`. |
| `src/freesound.ts` | Freesound APIv2 client: search URL and filters, parsing, errors, preview download. |
| `src/wav.ts` | PCM WAV encoder (16/24-bit), and WAV/AIFF detection. |
| `src/logic.ts` | Engine logic with no DOM: upload, then new track and clip at the playhead in one transaction; credits. |
| `src/main.ts` | DOM wiring: connect, settings, search, preview, import, drop zone, credits. |
| `tests/*.test.ts` | Vitest, against `Luna.MockEngine` and a fake `fetch`. No LUNA or key needed. |
| `tests/probe/` | `npm run test:page`: the built page in headless Chrome on the mock engine, with Freesound faked. |

### How it talks to Freesound

Requests are plain GETs with the key as the `token` query parameter, so the browser sends no
CORS preflight. Freesound answers `Access-Control-Allow-Origin: *` on both the API and the
preview CDN. That matters because inside LUNA the page runs on its own origin.

## License

[Apache-2.0](LICENSE). Release builds bundle the LUNA Builder SDK
(`vendor/luna.global.js`, © Universal Audio, Inc., Apache-2.0); see [NOTICE](NOTICE).
Sounds you find through the Add On are licensed by their authors on Freesound, not by this
project.
