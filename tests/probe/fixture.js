// ua-builder probe --mock tests/probe/fixture.js: a session with two tracks for the page to use.
globalThis.LunaMockSetup = (engine) => {
  engine.addSession('demo', { name: 'Probe Session', tracks: ['Vocal', 'Bass'] });
};
