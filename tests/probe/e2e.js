// Drives the page end to end in headless Chrome against the mock engine, with Freesound faked
// in the page: save a key, search, import a result, drop a local file.
// ua-builder probe <url> --mock tests/probe/fixture.js --expr "$(cat tests/probe/e2e.js)"
(async () => {
  const $ = (id) => document.getElementById(id);
  const until = async (fn, what, ms = 8000) => {
    const end = Date.now() + ms;
    while (!fn()) { if (Date.now() > end) throw new Error(`timed out: ${what}; status "${$('status').textContent}"`); await new Promise((r) => setTimeout(r, 50)); }
  };
  const wav = (seconds, rate = 44100) => {
    const n = Math.round(seconds * rate), b = new ArrayBuffer(44 + n * 4), v = new DataView(b);
    const s = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    s(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); s(8, 'WAVE'); s(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 4, true);
    v.setUint16(32, 4, true); v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, n * 4, true);
    for (let i = 0; i < n; i++) { const x = Math.round(Math.sin(i / 10) * 8000); v.setInt16(44 + i * 4, x, true); v.setInt16(46 + i * 4, x, true); }
    return b;
  };
  const seen = [];
  const sound = (id, name, license) => ({ id, name, username: 'tester', license, url: `https://freesound.org/s/${id}/`, duration: 0.5, channels: 2, samplerate: 44100, tags: ['kick'], previews: { 'preview-hq-mp3': `https://fake.test/${id}.wav` }, images: {}, bpm: 120, tonality: 'C minor' });
  window.fetch = async (url) => {
    url = String(url); seen.push(url.replace(/token=[^&]+/, 'token=***'));
    if (url.includes('/apiv2/search/')) return new Response(JSON.stringify({ count: 2, next: null, previous: null, results: [sound(1, 'Kick One.wav', 'http://creativecommons.org/publicdomain/zero/1.0/'), sound(2, 'Kick Two', 'http://creativecommons.org/licenses/by/4.0/')] }), { headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://fake.test/')) return new Response(wav(0.5));
    return new Response('{}', { status: 404 });
  };
  const out = {};
  await until(() => $('session').textContent === 'Probe Session', 'session');
  out.dialogOpenWithoutKey = $('settings').open;
  $('key-input').value = 'test-key'; $('key-form').requestSubmit();
  await until(() => $('key-state').textContent === 'API key saved', 'key saved');
  out.dialogClosedAfterSave = !$('settings').open;
  $('q').value = 'kick'; $('license').value = 'cc0'; $('search').requestSubmit();
  await until(() => document.querySelectorAll('.row').length === 2, 'results');
  out.rows = [...document.querySelectorAll('.row')].map((r) => `${r.querySelector('.name').textContent} | ${r.querySelector('.facts').textContent} | ${r.querySelector('.license').textContent}`);
  document.querySelector('.row .import').click();
  await until(() => /Imported|:/.test($('status').textContent) && !$('status').textContent.endsWith('…'), 'import');
  out.importStatus = $('status').textContent;
  out.credits = $('credits-text').textContent;
  $('target').value = 'focused'; $('target').dispatchEvent(new Event('change'));
  const dt = new DataTransfer(); dt.items.add(new File([wav(1, 48000)], 'My Loop.wav', { type: 'audio/wav' }));
  $('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  await until(() => /My Loop/.test($('status').textContent) && !$('status').textContent.endsWith('…'), 'drop import');
  out.dropStatus = $('status').textContent;
  out.targetLabel = $('target').selectedOptions[0].textContent;
  out.requests = seen;
  return out;
})()
