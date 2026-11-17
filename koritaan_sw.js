/*
 * Koritaan's offline worker.
 *
 * The web version is how iPhones get the app, often over poor connections,
 * and it must keep working with no internet after the first visit, as the
 * Android app does once its voices are downloaded. This worker keeps:
 *
 *  - the app itself (index.html, the compiled app, its assets and fonts),
 *    all fetched when a build is installed and served from the device first.
 *    A new deploy brings a new worker (tools/deploy_web.sh writes the
 *    build's fingerprint into it), which fetches what changed into a new
 *    cache and deletes the old one; the page shows the new build the next
 *    time it is opened;
 *  - the engine and fonts Flutter loads from Google's servers;
 *  - the recorded voice lines (media/play/**, media/tts/**), kept the first
 *    time they are played, and every line the app asks it to keep (the
 *    parent page's voice download, a play lesson's own lines).
 *
 * It never keeps API calls (/api/), and only ever handles GET requests.
 *
 * Flutter's own flutter_service_worker.js is a stub that unregisters
 * itself. This worker has its own name, so the stub is never fetched for it;
 * flutter_bootstrap.js must never pass serviceWorkerSettings, or Flutter
 * would register the stub in this worker's place and it would remove it.
 */
'use strict';

// tools/deploy_web.sh puts the build's fingerprint here. Left as it is (a
// build served some other way), the app is fetched from the network first
// and the copy kept is used only with no connection.
const BUILD = '61882d1ee496';
const STAMPED = BUILD.indexOf('__') !== 0;

const SCOPE = self.registration.scope;
const SCOPE_URL = new URL(SCOPE);

const SHELL_PREFIX = 'koritaan-shell-';
const SHELL = SHELL_PREFIX + (STAMPED ? BUILD : 'local');
// Not tied to a build: what they hold does not change with the app, and a
// family's voice download must outlive every deploy. Renaming VOICE throws
// every download away.
const CDN = 'koritaan-cdn-v1';
const VOICE = 'koritaan-voice-v1';
// The caches Flutter's own worker kept, before it became a stub.
const FLUTTER_CACHES = ['flutter-app-manifest', 'flutter-temp-cache', 'flutter-app-cache'];

// The mark the app puts on a request for a line it wants kept
// (lib/core/services/browser_audio_store_web.dart). It never leaves the
// device: the line is fetched again here, without it.
const KEEP_HEADER = 'x-koritaan-keep';

// The media host varies its answers by Origin, which requests made here do
// not carry.
const MATCH = { ignoreVary: true };

const INDEX = new URL('index.html', SCOPE).href;
// The build's files, each with a fingerprint of its content
// (tools/deploy_web.sh); kept in the shell cache too, so the next build
// copies what did not change instead of fetching it again.
const LIST = new URL('koritaan_files.json', SCOPE).href;

// What the app cannot start without: a build missing one of these is not
// installed, and the worker before it stays.
const CORE = [
  'index.html',
  'flutter_bootstrap.js',
  'main.dart.js',
  'manifest.json',
  'assets/AssetManifest.bin.json',
  'assets/FontManifest.json',
];

// Files of the app's folder that are never kept: the workers and the list.
const NEVER = ['koritaan_sw.js', 'koritaan_files.json', 'flutter_service_worker.js'];

// A copy the browser may not read (from a host that does not let other
// sites read its files: "opaque") cannot be cut into the byte ranges
// Safari's player asks for, so it is kept only where it would play. On an
// iPhone every browser is Safari underneath.
const UA = self.navigator.userAgent;
const OPAQUE_PLAYS = !(/AppleWebKit/.test(UA) && !/Chrome\/|Chromium\//.test(UA));

// -- What is what -----------------------------------------------------------

/** The path of [url] inside the app's folder, or null when it is outside. */
function appPath(url) {
  if (url.origin !== SCOPE_URL.origin || !url.pathname.startsWith(SCOPE_URL.pathname)) {
    return null;
  }
  return url.pathname.slice(SCOPE_URL.pathname.length);
}

/** A file of the app. Not the media folder: only its voices are kept. */
function isShell(url) {
  const path = appPath(url);
  return path !== null && !path.startsWith('media/') && NEVER.indexOf(path) < 0;
}

/** A recorded voice line, on whichever host: kept the first time it plays. */
function isVoice(url) {
  return /\/media\/(play|tts)\//.test(url.pathname) && /\.mp3$/i.test(url.pathname);
}

/**
 * One aayah of a reciter, as the play lessons use them: served from the
 * device when the app asked for it to be kept, else streamed as always (the
 * Qur'an reader's recitations are not kept by playing them).
 */
function isAayah(url) {
  return url.hostname === 'cdn.islamic.network' && url.pathname.startsWith('/quran/audio/128/');
}

/** The engine and fonts Flutter loads from Google: never change once out. */
function isCdn(url) {
  return url.hostname === 'fonts.gstatic.com' ||
    (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/flutter-canvaskit/'));
}

/** A visit to a page of the app (not a link straight to one of its files). */
function isPage(request, url) {
  if (request.mode !== 'navigate') return false;
  const last = (appPath(url) || '').split('/').pop();
  return last === '' || last.endsWith('.html') || last.indexOf('.') < 0;
}

function sameOrigin(href) {
  return new URL(href).origin === self.location.origin;
}

// -- Install, activate ------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(install().then(() => self.skipWaiting()));
});

async function install() {
  const cache = await caches.open(SHELL);
  const list = STAMPED ? await buildList() : null;
  const older = STAMPED ? await olderShell() : null;
  const files = list ? list.files : {};
  const core = await pool(CORE, (path) => keepFile(cache, path, files[path], older));
  if (core.indexOf(false) >= 0) throw new Error('Koritaan: the app could not be fetched whole');
  // Pictures, voices, fonts: as many as come now; the rest when first used,
  // or when the page next hands its list over ('koritaan-loaded').
  const rest = Object.keys(files).filter((path) => CORE.indexOf(path) < 0);
  await pool(rest, (path) => keepFile(cache, path, files[path], older));
  if (list) {
    await cache.put(LIST, new Response(JSON.stringify(list), {
      headers: { 'Content-Type': 'application/json' },
    }));
  }
}

/** This build's list of files. One of another build would mix the two. */
async function buildList() {
  const response = await fetch(LIST + '?v=' + BUILD, { cache: 'no-cache' });
  if (!response.ok) throw new Error('Koritaan: no file list for build ' + BUILD);
  const list = await response.json();
  if (list.build !== BUILD || !list.files) {
    throw new Error('Koritaan: the file list is of another build; trying again later');
  }
  return list;
}

/** The build kept before this one, with its list, to copy from. */
async function olderShell() {
  for (const name of await caches.keys()) {
    if (!name.startsWith(SHELL_PREFIX) || name === SHELL) continue;
    const cache = await caches.open(name);
    const saved = await cache.match(LIST);
    if (!saved) continue;
    try {
      return { cache: cache, files: (await saved.json()).files || {} };
    } catch (e) {
      // Unreadable: its files are fetched again.
    }
  }
  return null;
}

/**
 * Puts the app's file [path] in [cache]: copied from the build before when
 * its fingerprint [hash] is the same, else from the network. False when it
 * could not be had.
 */
async function keepFile(cache, path, hash, older) {
  const href = new URL(path, SCOPE).href;
  try {
    // A fingerprinted build's file never changes; a local build's may.
    if (STAMPED && (await cache.match(href))) return true;
    if (older && hash && older.files[path] === hash) {
      const copy = await older.cache.match(href);
      if (copy) {
        await cache.put(href, copy);
        return true;
      }
    }
    // Asked of the server, not taken from the browser's own cache, which may
    // still hold the build before.
    const response = await fetch(href, { cache: 'no-cache' });
    if (response.status !== 200) return false;
    await cache.put(href, await unredirected(response));
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * [response] without the mark of a redirect it went through: a page served
 * with one is refused by the browser.
 */
async function unredirected(response) {
  if (!response.redirected) return response;
  return new Response(await response.blob(), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Runs [work] on each of [items], six at a time; its results, in order. */
async function pool(items, work) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i]);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(6, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      const old = (name.startsWith(SHELL_PREFIX) && name !== SHELL) ||
        FLUTTER_CACHES.indexOf(name) >= 0;
      if (old) await caches.delete(name);
    }
    // In charge of the page that installed it straight away, so the voices
    // of the first visit are kept too.
    await self.clients.claim();
  })());
});

// -- Requests ---------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
  if (url.pathname.indexOf('/api/') >= 0) return;
  const keep = request.headers.has(KEEP_HEADER);
  let answer = null;
  if (keep || isVoice(url) || isAayah(url)) {
    answer = voice(event, request, url, keep);
  } else if (isCdn(url)) {
    answer = fromCdn(event, request, url);
  } else if (isShell(url)) {
    answer = shell(event, request, url);
  }
  if (!answer) return;
  // Whatever goes wrong here (a browser whose cache cannot be opened), the
  // request still reaches the network, as it would with no worker. A keep
  // request is only ever answered here: its mark must not leave the device.
  event.respondWith(answer.catch(() =>
    keep ? new Response(null, { status: 503 }) : fetch(request)));
});

/**
 * A voice line: from the device once kept. The first time, it is fetched
 * whole and kept, and the player gets the part it asked for. A request with
 * the keep mark is answered 204 once the line is kept, or with the status
 * that kept it from being kept.
 */
async function voice(event, request, url, keep) {
  const cache = await caches.open(VOICE);
  const href = url.href;
  const kept = await cache.match(href, MATCH);
  if (kept) return keep ? new Response(null, { status: 204 }) : ranged(request, kept);
  // An aayah nobody asked to keep streams, as it always did.
  if (!keep && !isVoice(url)) return fetch(request);
  const response = await whole(href);
  if (!response) {
    // Offline (or, in Safari, a host whose copy would not play): the
    // browser tries it its own way.
    return keep ? new Response(null, { status: 503 }) : fetch(request);
  }
  const storable = response.status === 200 || response.type === 'opaque';
  if (storable) {
    try {
      await cache.put(href, response.clone());
    } catch (e) {
      // The device is full: it plays, and is not kept.
      if (keep) return new Response(null, { status: 507 });
    }
  }
  if (keep) return new Response(null, { status: storable ? 204 : response.status });
  return storable ? ranged(request, response) : response;
}

/**
 * The whole of [href], with no byte range: readable where its host allows
 * it, else, in a browser that can play such a copy, as an opaque one. Null
 * when it cannot be had.
 */
async function whole(href) {
  const same = sameOrigin(href);
  try {
    return await fetch(href, same ? {} : { mode: 'cors', credentials: 'omit' });
  } catch (e) {
    // Offline, or a host that does not let other sites read its files.
  }
  if (same || !OPAQUE_PLAYS) return null;
  try {
    return await fetch(href, { mode: 'no-cors', credentials: 'omit' });
  } catch (e) {
    return null;
  }
}

/**
 * [response], or the part of it [request] asks for. Audio players ask for
 * byte ranges, and Safari's plays nothing that does not answer them.
 */
async function ranged(request, response) {
  const range = request.headers.get('range');
  if (!range || response.type === 'opaque' || response.status !== 200) return response;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  // Several ranges, or a form not understood: the whole file, as a server
  // that does not do ranges would answer.
  if (!match || (match[1] === '' && match[2] === '')) return response;
  const body = await response.arrayBuffer();
  const size = body.byteLength;
  let start;
  let end;
  if (match[1] === '') {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': 'bytes */' + size },
    });
  }
  return new Response(body.slice(start, end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': response.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

/** Google's engine and fonts: from the device once fetched. */
async function fromCdn(event, request, url) {
  const cache = await caches.open(CDN);
  const kept = await cache.match(url.href, MATCH);
  if (kept) return kept;
  const response = await fetch(request);
  if (response.status === 200 && response.type !== 'opaque') {
    event.waitUntil(keepCdn(cache, url, response.clone()));
  }
  return response;
}

/** Keeps a file of Google's, and drops the engines of earlier builds. */
async function keepCdn(cache, url, response) {
  try {
    await cache.put(url.href, response);
    const engine = /^\/flutter-canvaskit\/([^/]+)\//.exec(url.pathname);
    if (!engine) return;
    for (const old of await cache.keys()) {
      const other = /^\/flutter-canvaskit\/([^/]+)\//.exec(new URL(old.url).pathname);
      if (other && other[1] !== engine[1]) await cache.delete(old);
    }
  } catch (e) {
    // Not kept: fetched again next time.
  }
}

/**
 * A file of the app. A fingerprinted build is served from the device
 * first: a new one arrives as a new worker. A local build comes from the
 * network first, so each rebuild shows at once, and from the device when
 * there is no connection.
 */
async function shell(event, request, url) {
  const cache = await caches.open(SHELL);
  const page = isPage(request, url);
  const key = page ? INDEX : url.href;
  if (STAMPED) {
    const kept = await cache.match(key, MATCH);
    if (kept) return ranged(request, kept);
  }
  let response;
  try {
    // A page as the browser asked for it; a file whole, never a byte range,
    // so that the copy kept is all of it.
    response = await fetch(page ? request : url.href, { cache: 'no-cache' });
  } catch (e) {
    const kept = await cache.match(key, MATCH);
    if (kept) return ranged(request, kept);
    throw e;
  }
  if (response.status === 200 && !(page && response.redirected)) {
    event.waitUntil(cache.put(key, response.clone()).catch(() => {}));
  }
  return ranged(request, response);
}

// -- What the page fetched before this worker was in charge ----------------

let shellWhole = false;

/**
 * The page hands over every address it fetched (index.html, after load):
 * on the first visit the engine, fonts and files came before this worker
 * was in charge, and are kept now. Then any file of the build the install
 * could not get is fetched, once all of it is kept no more.
 */
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'koritaan-loaded' || !Array.isArray(data.urls)) return;
  event.waitUntil(keepLoaded(data.urls));
});

async function keepLoaded(urls) {
  for (const href of urls) {
    let url;
    try {
      url = new URL(href);
    } catch (e) {
      continue;
    }
    if (url.pathname.indexOf('/api/') >= 0) continue;
    const name = isCdn(url) ? CDN : isVoice(url) ? VOICE : isShell(url) ? SHELL : null;
    if (!name) continue;
    try {
      const cache = await caches.open(name);
      if (await cache.match(url.href, MATCH)) continue;
      const response = name === VOICE
        ? await whole(url.href)
        : await fetch(url.href, name === CDN ? { mode: 'cors', credentials: 'omit' } : { cache: 'no-cache' });
      if (!response || !(response.status === 200 || (name === VOICE && response.type === 'opaque'))) {
        continue;
      }
      if (name === CDN) {
        await keepCdn(cache, url, response);
      } else {
        await cache.put(url.href, response);
      }
    } catch (e) {
      // Tried again next time the page hands its list over.
    }
  }
  if (STAMPED && !shellWhole) shellWhole = await fillShell();
}

/** Fetches every file of the build not kept yet. True when all are kept. */
async function fillShell() {
  try {
    const cache = await caches.open(SHELL);
    const saved = await cache.match(LIST);
    if (!saved) return false;
    const files = (await saved.json()).files || {};
    const kept = await pool(Object.keys(files), (path) => keepFile(cache, path, null, null));
    return kept.indexOf(false) < 0;
  } catch (e) {
    return false;
  }
}
