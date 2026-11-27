/**
 * Where the twin's model comes from, decided at runtime with no configuration.
 *
 *   - Open-FDD installed and answering: read the Haystack Turtle its `rdf` hook serves (Open-FDD's own graph of the
 *     NF tags) and derive 223P from it. One run per re-check, first page only when its snapshot is unchanged.
 *   - Open-FDD absent, erroring, slow or upgraded to an answer this page does not understand: build the same Turtle
 *     here from NF's point records with the vendored copy of Open-FDD's modelToTurtle.
 *
 * Either way the snapshot is the sha256 of that Turtle (the value Open-FDD's rdf hook reports), so the derived model
 * is rebuilt only when NF tags change, never because the source switched. One model is cached; the Turtle and
 * triples are dropped after the build. Reads only: nothing here writes to NF or to Open-FDD.
 *
 * Browser global NfftModelSource; CommonJS for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else /** @type {any} */ (root).NfftModelSource = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OPEN_FDD_APP = 'open-fdd';
  const DEFAULTS = { timeoutMs: 5000, pageTimeoutMs: 15000, recheckMs: 5 * 60 * 1000, pageLimit: 150000, maxPages: 40 };

  // ---- sha256 (pure JS; crypto.subtle is missing on plain-http NF pages) ----
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  /** @param {string} text @returns {string} hex sha256 of the UTF-8 bytes */
  function sha256(text) {
    const bytes = new TextEncoder().encode(text);
    const len = bytes.length;
    const words = new Uint32Array((((len + 9 + 63) >> 6) << 4));
    for (let i = 0; i < len; i += 1) words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
    words[len >> 2] |= 0x80 << (24 - (len % 4) * 8);
    words[words.length - 1] = len * 8;
    words[words.length - 2] = Math.floor(len / 0x20000000);
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const rotr = (/** @type {number} */ x, /** @type {number} */ n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < words.length; off += 16) {
      for (let i = 0; i < 16; i += 1) w[i] = words[off + i];
      for (let i = 16; i < 64; i += 1) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i += 1) {
        const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
  }

  /** Reject after ms; aborts the controller so pending requests stop. */
  function withTimeout(/** @type {(signal: any) => Promise<any>} */ run, /** @type {number} */ ms, /** @type {string} */ what) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    /** @type {any} */
    let timer = null;
    return Promise.race([
      run(ctrl ? ctrl.signal : null),
      new Promise((_, reject) => { timer = setTimeout(() => { if (ctrl) ctrl.abort(); reject(new Error(`${what} did not answer within ${ms} ms`)); }, ms); }),
    ]).finally(() => clearTimeout(timer));
  }

  /**
   * Open-FDD's graph, through its read-only `rdf` hook. Validates the answer shape, so an upgrade that changes it
   * falls back instead of breaking.
   * @param {(hook: string, args: Record<string, string>, opts: { signal: any }) => Promise<any>} callOpenFddHook
   * @param {{ known: string|null, signal: any, pageLimit: number, maxPages: number }} o
   */
  async function readOpenFdd(callOpenFddHook, o) {
    const page = async (/** @type {number} */ offset, /** @type {string|null} */ snapshot) => {
      const args = /** @type {Record<string, string>} */ ({ offset: String(offset), limit: String(o.pageLimit) });
      if (snapshot) args.snapshot = snapshot;
      const a = await callOpenFddHook('rdf', args, { signal: o.signal });
      if (!a || a.ok !== true) throw new Error(`Open-FDD rdf hook answered ${a && a.error ? a.error : 'not ok'}`);
      if (typeof a.snapshot !== 'string' || typeof a.turtle !== 'string' || !(a.next_offset === null || Number.isInteger(a.next_offset))) {
        throw new Error('Open-FDD rdf answer has an unknown shape');
      }
      return a;
    };
    const first = await page(0, null);
    if (o.known && first.snapshot === o.known) return { snapshot: first.snapshot, turtle: null, pages: 1 };
    let turtle = first.turtle;
    let next = first.next_offset;
    let pages = 1;
    while (next !== null) {
      if (pages >= o.maxPages) throw new Error('Open-FDD graph is larger than this page reads');
      const a = await page(next, first.snapshot);
      if (a.offset !== next) throw new Error('Open-FDD rdf paging went out of step');
      turtle += a.turtle;
      next = a.next_offset;
      pages += 1;
    }
    if (sha256(turtle) !== first.snapshot) throw new Error('Open-FDD graph changed or was cut while paging');
    return { snapshot: first.snapshot, turtle, pages };
  }

  /**
   * The built-in graph: NF records -> Open-FDD's modelToTurtle (vendored, unmodified).
   * @param {{ model: any[], points: any[] }} records
   * @param {{ toPoint: Function, modelToTurtle: Function, rdfBaseOf: Function, ENTITY_TYPES?: string[] }} modelJs
   */
  function localTurtle(records, modelJs) {
    const types = modelJs.ENTITY_TYPES || ['SITE', 'EQUIPMENT', 'DEVICE'];
    const of = (/** @type {string} */ t) => records.model.filter((r) => r.pointType === t);
    const model = {
      sites: of('SITE'), equips: of('EQUIPMENT'), devices: of('DEVICE'),
      points: records.points.filter((r) => !types.includes(r.pointType)).map((r) => modelJs.toPoint(r)),
    };
    // nfBase '' exactly as Open-FDD's rdf hook builds it, so both sources give the same snapshot.
    const { turtle } = modelJs.modelToTurtle(model, modelJs.rdfBaseOf(), { nfBase: '' });
    return /** @type {string} */ (turtle);
  }

  /**
   * NF records the way Open-FDD's hooks read them: model layer, then each site's default layer.
   * @param {(body: any) => Promise<any[]>} queryAll a pager over POST /api/v1/point/query
   * @param {(r: any) => string} idOf
   */
  async function loadRecords(queryAll, idOf) {
    const model = await queryAll({ layer: 'model' });
    const sites = model.filter((r) => r.pointType === 'SITE');
    /** @type {any[]} */
    const points = [];
    for (const s of sites) points.push(...await queryAll({ layer: 'default', structuredQuery: { field: { property: 'siteRef', text: idOf(s) } } }));
    return { model, points };
  }

  /**
   * @param {{
   *   callOpenFddHook?: ((hook: string, args: Record<string, string>, opts: { signal: any }) => Promise<any>) | null,
   *   loadRecords: () => Promise<{ model: any[], points: any[] }>,
   *   modelJs: any,
   *   build: (turtle: string) => any,
   *   now?: () => number,
   *   timeoutMs?: number, pageTimeoutMs?: number, recheckMs?: number, pageLimit?: number, maxPages?: number,
   * }} opts
   */
  function createModelSource(opts) {
    const o = { ...DEFAULTS, ...opts };
    const now = opts.now || (() => Date.now());
    /** @type {any} */
    let cache = null;
    /** @type {Promise<any>|null} */
    let inflight = null;
    let builds = 0;
    let openFddRuns = 0;

    async function fromOpenFdd(/** @type {string|null} */ known) {
      if (!o.callOpenFddHook) throw new Error('Open-FDD client not available');
      const call = o.callOpenFddHook;
      // The first page doubles as the presence check, under the short timeout; paging the rest gets longer.
      return withTimeout((signal) => readOpenFdd((hook, args, x) => {
        openFddRuns += 1;
        return withTimeout(() => call(hook, args, x), args.offset === '0' ? o.timeoutMs : o.pageTimeoutMs, 'Open-FDD');
      }, { known, signal, pageLimit: o.pageLimit, maxPages: o.maxPages }), o.timeoutMs + o.pageTimeoutMs, 'Open-FDD');
    }

    async function refresh() {
      const known = cache ? cache.snapshot : null;
      let source = 'open-fdd';
      /** @type {string|null} */
      let note = null;
      /** @type {{ snapshot: string, turtle: string|null }} */
      let got;
      try {
        got = await fromOpenFdd(known);
      } catch (e) {
        source = 'built-in';
        note = `Open-FDD graph not used: ${String((e && /** @type {any} */ (e).message) || e)}`;
        const turtle = localTurtle(await o.loadRecords(), o.modelJs);
        got = { snapshot: sha256(turtle), turtle };
      }
      const checkedAt = now();
      if (cache && cache.snapshot === got.snapshot) {
        cache = { ...cache, source, note, checkedAt, rebuilt: false };
        return cache;
      }
      const turtle = got.turtle;
      if (turtle === null) throw new Error('model snapshot changed without a graph');
      const model = o.build(turtle);
      builds += 1;
      cache = { source, note, snapshot: got.snapshot, model, builtAt: checkedAt, checkedAt, rebuilt: true };
      return cache;
    }

    return {
      /** The cached model, re-checked when older than recheckMs (or when forced). Concurrent calls share one check. */
      get(/** @type {{ force?: boolean }} */ x = {}) {
        if (!x.force && cache && now() - cache.checkedAt < o.recheckMs) return Promise.resolve({ ...cache, rebuilt: false });
        if (!inflight) inflight = refresh().finally(() => { inflight = null; });
        return inflight;
      },
      stats: () => ({ builds, openFddRuns, source: cache ? cache.source : null, snapshot: cache ? cache.snapshot : null }),
      recheckMs: o.recheckMs,
    };
  }

  return { createModelSource, readOpenFdd, localTurtle, loadRecords, sha256, withTimeout, OPEN_FDD_APP, DEFAULTS };
});
