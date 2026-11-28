// ASHRAE 223P model reader for the page. Pure: Oxigraph quads to a triple index, role matching against the
// Open-FDD role patterns (roles-223p.js), and a walk of the air path that finds air handlers, their parts in
// air-path order, the duct tree they feed, terminal units and the spaces those serve. Nothing here names a site,
// an equipment id or a point; everything comes from the model. Display only: the hooks still refuse RDF input.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NfftS223 = factory();
})(globalThis, function () {
  'use strict';

    /** Prefixes the role patterns use. `ext:` comes from the model's own prefix declaration. */
  const KNOWN = {
    s223: 'http://data.ashrae.org/standard223#',
    quantitykind: 'http://qudt.org/vocab/quantitykind/',
    unit: 'http://qudt.org/vocab/unit/',
    qudt: 'http://qudt.org/schema/qudt/',
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  };

  /**
   * Prefix declarations of a Turtle document (`@prefix` and SPARQL-style `PREFIX`). Oxigraph parses the triples;
   * this only recovers the names the model uses, so `ext:` terms compare with the role patterns.
   * @param {string} text
   */
  function prefixesOf(text) {
    /** @type {Record<string, string>} */
    const out = {};
    const re = /(?:@prefix|\bPREFIX)\s+([A-Za-z][\w.-]*)?:\s*<([^>]*)>/gi;
    let m;
    while ((m = re.exec(String(text || '')))) out[m[1] || ''] = m[2];
    return out;
  }

  /**
   * Oxigraph quads to the plain triples this module indexes.
   * @param {any[]} quads from oxigraph `parse()` or `Store.match()`
   * @param {string} [text] the Turtle source, for its prefixes
   */
  function fromQuads(quads, text) {
    const term = (/** @type {any} */ t) => {
      if (t.termType === 'BlankNode') return `_:${t.value}`;
      if (t.termType === 'Literal') return { value: t.value, datatype: t.datatype ? t.datatype.value : null, lang: t.language || null };
      return t.value;
    };
    return {
      triples: quads.map((q) => ({ s: term(q.subject), p: q.predicate.value, o: term(q.object) })),
      prefixes: prefixesOf(text || ''),
    };
  }

  /**
   * Parse Turtle with Oxigraph (the vendored static/vendor/oxigraph build, web or Node).
   * @param {any} oxigraph the loaded module
   * @param {string} text
   */
  function parseTurtle(oxigraph, text) {
    return fromQuads(oxigraph.parse(String(text || ''), { format: 'text/turtle' }), text);
  }

  /**
   * Index with CURIE compaction (known prefixes plus the model's own).
   * @param {{ triples: { s: string, p: string, o: any }[], prefixes: Record<string, string> }} parsed
   */
  function graph(parsed) {
    /** @type {[string, string][]} */
    const table = Object.entries({ ...parsed.prefixes, ...KNOWN }).sort((a, b) => b[1].length - a[1].length);
    const compact = (/** @type {string} */ iri) => {
      if (typeof iri !== 'string' || iri.startsWith('_:')) return iri;
      for (const [prefix, ns] of table) if (ns && iri.startsWith(ns)) return `${prefix}:${iri.slice(ns.length)}`;
      return iri;
    };
    /** @type {Map<string, Map<string, any[]>>} */
    const bySubject = new Map();
    /** @type {Map<string, Map<string, string[]>>} */
    const byObject = new Map();
    const order = new Map();
    for (const t of parsed.triples) {
      const s = compact(t.s);
      const p = compact(t.p);
      const o = typeof t.o === 'string' ? compact(t.o) : t.o;
      if (!order.has(s)) order.set(s, order.size);
      if (!bySubject.has(s)) bySubject.set(s, new Map());
      const sp = /** @type {Map<string, any[]>} */ (bySubject.get(s));
      if (!sp.has(p)) sp.set(p, []);
      /** @type {any[]} */ (sp.get(p)).push(o);
      if (typeof o === 'string') {
        if (!byObject.has(o)) byObject.set(o, new Map());
        const op = /** @type {Map<string, string[]>} */ (byObject.get(o));
        if (!op.has(p)) op.set(p, []);
        /** @type {string[]} */ (op.get(p)).push(s);
      }
    }
    const api = {
      size: parsed.triples.length,
      compact,
      /** @param {string} s @param {string} p */
      objects: (s, p) => ((bySubject.get(s) || new Map()).get(p) || []),
      /** @param {string} p @param {string} o */
      subjects: (p, o) => ((byObject.get(o) || new Map()).get(p) || []),
      /** @param {string} p subjects that have any value for p */
      withPredicate: (p) => [...bySubject.entries()].filter(([, m]) => m.has(p)).map(([s]) => s),
      /** @param {string} s */
      types: (s) => /** @type {string[]} */ (api.objects(s, 'rdf:type').filter((o) => typeof o === 'string')),
      /** @param {string} s @param {string} type */
      is: (s, type) => api.types(s).includes(type),
      /** @param {string} type */
      ofType: (type) => api.subjects('rdf:type', type).slice().sort((a, b) => order.get(a) - order.get(b)),
      /** @param {string} s */
      allObjects: (s) => {
        const set = new Set();
        for (const values of (bySubject.get(s) || new Map()).values()) for (const v of values) if (typeof v === 'string') set.add(v);
        return set;
      },
      /** @param {string} s @param {string} p */
      literal: (s, p) => {
        const v = api.objects(s, p).find((o) => o && typeof o === 'object');
        if (!v) return null;
        if (/(integer|decimal|double|float)$/.test(v.datatype || '')) return Number(v.value);
        if (/boolean$/.test(v.datatype || '')) return v.value === 'true';
        return v.value;
      },
      /** @param {string} s */
      label: (s) => /** @type {string | null} */ (api.literal(s, 'rdfs:label')),
      order: (/** @type {string} */ s) => (order.has(s) ? order.get(s) : Infinity),
    };
    return api;
  }

  /** @param {string} iri */
  function localId(iri) {
    const m = /[#/:]([^#/:]+)$/.exec(iri);
    return m ? m[1] : iri;
  }

  // ---- role matching ----

  /**
   * Everything a role pattern can test about one property.
   * @param {any} g
   * @param {string} prop
   */
  function propertyContext(g, prop) {
    const holders = g.subjects('s223:hasProperty', prop);
    const sensors = g.subjects('s223:observes', prop);
    /** @type {Set<string>} */
    const cps = new Set();
    /** @type {Set<string>} */
    const owners = new Set();
    const consider = (/** @type {string} */ x) => {
      if (isConnectionPoint(g, x)) {
        cps.add(x);
        for (const e of cpOwners(g, x)) owners.add(e);
      } else owners.add(x);
    };
    for (const h of holders) consider(h);
    if (!owners.size) for (const s of sensors) for (const loc of g.objects(s, 's223:hasObservationLocation')) consider(loc);
    const owner = [...owners].sort((a, b) => g.order(a) - g.order(b))[0] || null;
    const top = owner ? topOf(g, owner) : null;
    const topTypes = new Set(top ? g.types(top) : []);
    if (top) for (const z of g.subjects('s223:hasDomainSpace', top)) for (const t of g.types(z)) topTypes.add(t);
    const cpRoles = new Set();
    const cpTypes = new Set();
    const cpMedia = new Set();
    for (const cp of cps) {
      for (const r of g.objects(cp, 's223:hasRole')) cpRoles.add(r);
      for (const t of g.types(cp)) cpTypes.add(t);
      for (const m of g.objects(cp, 's223:hasMedium')) cpMedia.add(m);
    }
    const equipMedia = new Set();
    if (owner) for (const cp of g.objects(owner, 's223:hasConnectionPoint')) for (const m of g.objects(cp, 's223:hasMedium')) equipMedia.add(m);
    return {
      prop,
      owner,
      top,
      location: [...cps][0] || null,
      types: new Set(g.types(prop)),
      quantityKind: g.objects(prop, 'qudt:hasQuantityKind')[0] || null,
      enumerationKind: g.objects(prop, 's223:hasEnumerationKind')[0] || null,
      aspects: new Set(g.objects(prop, 's223:hasAspect')),
      media: new Set([...g.objects(prop, 's223:ofMedium'), ...cpMedia]),
      constituents: new Set([...g.objects(prop, 's223:ofConstituent'), ...g.objects(prop, 's223:ofSubstance')]),
      all: g.allObjects(prop),
      cpRoles,
      cpTypes,
      equipTypes: new Set(owner ? g.types(owner) : []),
      equipRoles: new Set(owner ? g.objects(owner, 's223:hasRole') : []),
      equipMedia,
      topTypes,
    };
  }

  /**
   * @param {any} pattern role s223 pattern
   * @param {any} ctx propertyContext
   */
  function patternMatches(pattern, ctx) {
    const has = (/** @type {Set<string>} */ set, /** @type {string} */ v) => set.has(v);
    if (pattern.property_class && !has(ctx.types, pattern.property_class)) return false;
    if (pattern.quantity_kind && ctx.quantityKind !== pattern.quantity_kind) return false;
    if (pattern.enumeration_kind && ctx.enumerationKind !== pattern.enumeration_kind) return false;
    for (const a of pattern.aspects || []) if (!has(ctx.aspects, a) && !has(ctx.all, a)) return false;
    for (const r of pattern.roles || []) if (!has(ctx.cpRoles, r) && !has(ctx.aspects, r)) return false;
    if (pattern.connection_point && !has(ctx.cpTypes, pattern.connection_point)) return false;
    if (pattern.medium && !has(ctx.media, pattern.medium)) return false;
    if (pattern.constituent && !has(ctx.constituents, pattern.constituent) && !has(ctx.all, pattern.constituent)) return false;
    if (pattern.qualifier && !has(ctx.all, pattern.qualifier)) return false;
    if (pattern.equipment && !has(ctx.equipTypes, pattern.equipment)) return false;
    if (pattern.equipment_role && !has(ctx.equipRoles, pattern.equipment_role)) return false;
    if (pattern.equipment_medium && !has(ctx.equipMedia, pattern.equipment_medium)) return false;
    if (pattern.applies_to && pattern.applies_to.length
      && !pattern.applies_to.some((/** @type {string} */ t) => has(ctx.topTypes, t) || has(ctx.equipTypes, t))) return false;
    return true;
  }

  /**
   * Role for one property. Candidates must match every slot of the pattern. A pattern without `scope` (the
   * property belongs to the equipment being assessed) beats a scoped one; then the most specific pattern wins.
   * A tie is ambiguous and yields no role.
   * @param {any} g
   * @param {string} prop
   * @param {any} vocab roles-223p
   */
  function matchRole(g, prop, vocab) {
    const ctx = propertyContext(g, prop);
    const inScope = (/** @type {any} */ r) => !r.s223.scope
      || (r.s223.applies_to && r.s223.applies_to.length > 0)
      || ctx.topTypes.has(r.s223.scope) || ctx.equipTypes.has(r.s223.scope);
    let hits = vocab.roles.filter((/** @type {any} */ r) => r.s223 && patternMatches(r.s223, ctx) && inScope(r));
    const unscoped = hits.filter((/** @type {any} */ r) => !r.s223.scope);
    if (unscoped.length) hits = unscoped;
    const score = (/** @type {any} */ r) => Object.keys(r.s223).filter((k) => k !== 'applies_to' && k !== 'scope').length;
    const best = Math.max(0, ...hits.map(score));
    const top = hits.filter((/** @type {any} */ r) => score(r) === best);
    return { ctx, role: top.length === 1 ? top[0] : null, candidates: hits.map((/** @type {any} */ r) => r.role) };
  }

  // ---- topology ----

  const PASS = ['s223:Duct', 's223:Connection', 's223:Junction', 's223:Pipe'];
  const SPACES = ['s223:DomainSpace', 's223:PhysicalSpace', 's223:Zone'];

  /** @param {any} g @param {string} x */
  function isConnectionPoint(g, x) {
    return g.types(x).some((/** @type {string} */ t) => /ConnectionPoint$/.test(t)) || g.subjects('s223:hasConnectionPoint', x).length > 0;
  }
  /** @param {any} g @param {string} cp */
  function cpOwners(g, cp) {
    return [...new Set([...g.subjects('s223:hasConnectionPoint', cp), ...g.objects(cp, 's223:isConnectionPointOf')])];
  }
  /** @param {any} g @param {string} node */
  function topOf(g, node) {
    let cur = node;
    const seen = new Set([cur]);
    for (;;) {
      const up = g.subjects('s223:contains', cur)[0];
      if (!up || seen.has(up)) return cur;
      seen.add(up);
      cur = up;
    }
  }
  /** @param {any} g @param {string} cp */
  function isAir(g, cp) {
    const media = g.objects(cp, 's223:hasMedium');
    return media.length === 0 || media.some((/** @type {string} */ m) => /Air/.test(m));
  }
  /** @param {any} g @param {string} cp */
  function direction(g, cp) {
    const t = g.types(cp);
    if (t.includes('s223:OutletConnectionPoint')) return 'out';
    if (t.includes('s223:InletConnectionPoint')) return 'in';
    return 'both';
  }
  /** @param {any} g @param {string} x */
  function isPass(g, x) {
    return PASS.some((t) => g.is(x, t));
  }

  /**
   * Directed air graph over connectables. Nodes are equipment, ducts, junctions and spaces; an edge follows
   * an outlet connection point through its connection to the next inlet.
   * @param {any} g
   */
  function airGraph(g) {
    /** @type {Map<string, Set<string>>} */
    const out = new Map();
    /** @type {Map<string, Set<string>>} */
    const inn = new Map();
    const add = (/** @type {string} */ a, /** @type {string} */ b) => {
      if (a === b) return;
      if (!out.has(a)) out.set(a, new Set());
      if (!inn.has(b)) inn.set(b, new Set());
      /** @type {Set<string>} */ (out.get(a)).add(b);
      /** @type {Set<string>} */ (inn.get(b)).add(a);
    };
    /** @type {Set<string>} */
    const cps = new Set();
    for (const t of ['s223:OutletConnectionPoint', 's223:InletConnectionPoint', 's223:BidirectionalConnectionPoint']) for (const cp of g.ofType(t)) cps.add(cp);
    for (const s of g.withPredicate('s223:connectsThrough')) cps.add(s);
    /** @type {Map<string, string[]>} */
    const connCps = new Map();
    const link = (/** @type {string} */ conn, /** @type {string} */ cp) => {
      if (!connCps.has(conn)) connCps.set(conn, []);
      const list = /** @type {string[]} */ (connCps.get(conn));
      if (!list.includes(cp)) list.push(cp);
    };
    for (const cp of cps) for (const conn of g.objects(cp, 's223:connectsThrough')) link(conn, cp);
    for (const t of PASS) {
      for (const conn of g.ofType(t)) for (const cp of g.objects(conn, 's223:connectsAt')) link(conn, cp);
    }
    for (const [conn, list] of connCps) {
      for (const cp of list) {
        if (!isAir(g, cp)) continue;
        const dir = direction(g, cp);
        for (const owner of cpOwners(g, cp)) {
          if (dir === 'out' || dir === 'both') add(owner, conn);
          if (dir === 'in' || dir === 'both') add(conn, owner);
        }
      }
    }
    for (const p of ['s223:connectedTo', 's223:connectsTo']) {
      for (const a of g.withPredicate(p)) for (const b of g.objects(a, p)) if (typeof b === 'string') add(a, b);
    }
    return { out, inn, next: (/** @type {string} */ n) => [...(out.get(n) || [])], prev: (/** @type {string} */ n) => [...(inn.get(n) || [])] };
  }

  /**
   * @param {any} g
   * @param {any} vocab
   * @param {string} node
   */
  function kindOf(g, vocab, node) {
    for (const t of g.types(node)) if (vocab.lexicon[t]) return vocab.lexicon[t];
    if (g.is(node, 's223:Junction')) return 'junction';
    if (g.is(node, 's223:Duct')) return 'duct';
    if (g.is(node, 's223:SingleDuctTerminal') || g.is(node, 's223:FanPoweredTerminal')) return 'terminal_unit';
    if (SPACES.some((t) => g.is(node, t))) return 'space';
    return 'equipment';
  }

  /**
   * @param {any} g
   * @param {string} node
   */
  function containsClosure(g, node) {
    /** @type {string[]} */
    const outList = [];
    const stack = [...g.objects(node, 's223:contains')];
    const seen = new Set();
    while (stack.length) {
      const x = /** @type {string} */ (stack.shift());
      if (seen.has(x) || typeof x !== 'string') continue;
      seen.add(x);
      outList.push(x);
      stack.push(...g.objects(x, 's223:contains'));
    }
    return outList;
  }

  /**
   * Read a 223P model into the page's equipment view.
   * @param {{ triples: any[], prefixes: Record<string, string> }} parsed parseTurtle() or fromQuads()
   * @param {any} vocab roles-223p
   */
  function discover(parsed, vocab) {
    const g = graph(parsed);
    const air = airGraph(g);
    /** @type {string[]} */
    const warnings = [];
    /** @type {any[]} */
    const ambiguous = [];
    /** @type {any[]} */
    const unmatched = [];
    /** @type {Map<string, any[]>} */
    const propsByOwner = new Map();
    const props = new Set();
    for (const t of ['s223:QuantifiableObservableProperty', 's223:QuantifiableActuatableProperty', 's223:EnumeratedObservableProperty', 's223:EnumeratedActuatableProperty', 's223:QuantifiableProperty', 's223:Property']) {
      for (const p of g.ofType(t)) props.add(p);
    }
    for (const p of props) {
      const hit = matchRole(g, p, vocab);
      const ctx = hit.ctx;
      const entry = {
        id: localId(p),
        iri: p,
        label: g.label(p),
        role: hit.role ? hit.role.role : null,
        actuatable: [...ctx.types].some((t) => /Actuatable/.test(t)),
        unit: g.objects(p, 'qudt:hasUnit')[0] || (hit.role ? hit.role.unit : null),
        value: g.literal(p, 's223:hasValue'),
        haystack: hit.role && hit.role.haystack ? hit.role.haystack.markers : [],
        location: ctx.location,
        owner: ctx.owner,
      };
      if (!hit.role) {
        if (hit.candidates.length > 1) ambiguous.push({ property: entry.id, candidates: hit.candidates });
        else unmatched.push(entry.id);
      }
      const key = ctx.owner || '';
      if (!propsByOwner.has(key)) propsByOwner.set(key, []);
      /** @type {any[]} */ (propsByOwner.get(key)).push(entry);
    }
    const propsOf = (/** @type {string} */ n) => (propsByOwner.get(n) || []).sort((a, b) => g.order(a.iri) - g.order(b.iri));
    const node = (/** @type {string} */ n) => ({
      id: localId(n),
      iri: n,
      label: g.label(n) || localId(n),
      kind: kindOf(g, vocab, n),
      types: g.types(n),
      roles: g.objects(n, 's223:hasRole'),
      props: propsOf(n),
    });

    const ahus = g.ofType('s223:AirHandlingUnit').map((/** @type {string} */ ahu) => {
      const parts = containsClosure(g, ahu);
      const partSet = new Set(parts);
      const internal = (/** @type {string} */ n) => partSet.has(n);
      // Edges between parts, passing through internal ducts and junctions that are not themselves parts.
      /** @type {[string, string][]} */
      const edges = [];
      for (const p of parts) {
        const seen = new Set([p]);
        const queue = air.next(p);
        while (queue.length) {
          const x = /** @type {string} */ (queue.shift());
          if (seen.has(x)) continue;
          seen.add(x);
          if (internal(x)) { edges.push([p, x]); continue; }
          if (isPass(g, x) && !air.prev(x).some((y) => !internal(y) && !isPass(g, y))) queue.push(...air.next(x).filter((y) => internal(y) || isPass(g, y)));
        }
      }
      const airParts = parts.filter((p) => edges.some(([a, b]) => a === p || b === p));
      // Longest-path layering, ignoring back edges.
      /** @type {Map<string, number>} */
      const layer = new Map();
      const visiting = new Set();
      const depth = (/** @type {string} */ n) => {
        if (layer.has(n)) return /** @type {number} */ (layer.get(n));
        if (visiting.has(n)) return 0;
        visiting.add(n);
        const ups = edges.filter(([, b]) => b === n).map(([a]) => a);
        const d = ups.length ? Math.max(...ups.map((u) => depth(u) + 1)) : 0;
        visiting.delete(n);
        layer.set(n, d);
        return d;
      };
      airParts.forEach(depth);
      // Supply outlets: parts whose air path, through ducts and junctions, reaches equipment outside the unit.
      const leaves = (/** @type {string} */ p) => {
        const seen2 = new Set([p]);
        const q2 = air.next(p);
        while (q2.length) {
          const x = /** @type {string} */ (q2.shift());
          if (seen2.has(x) || internal(x)) continue;
          seen2.add(x);
          if (!isPass(g, x)) return true;
          q2.push(...air.next(x));
        }
        return false;
      };
      const outlets = airParts.filter(leaves);
      if (!outlets.length && airParts.length) warnings.push(`${localId(ahu)}: no air connection leaves the unit`);
      // Main lane: walk back from the outlet along the deepest predecessor.
      const lane = new Map();
      let cur = outlets[0];
      while (cur) {
        lane.set(cur, 0);
        const ups = edges.filter(([, b]) => b === cur).map(([a]) => a).sort((a, b) => (layer.get(b) || 0) - (layer.get(a) || 0) || g.order(a) - g.order(b));
        cur = ups.find((u) => !lane.has(u));
      }
      let nextLane = 1;
      for (const p of airParts.slice().sort((a, b) => (layer.get(a) || 0) - (layer.get(b) || 0) || g.order(a) - g.order(b))) {
        if (!lane.has(p)) {
          const down = edges.find(([a]) => a === p);
          const shared = down && lane.has(down[1]) && [...lane.entries()].find(([k, v]) => v > 0 && edges.some(([a, b]) => a === k && b === down[1]));
          lane.set(p, shared ? shared[1] : nextLane++);
        }
      }
      const orderedParts = parts.slice().sort((a, b) => {
        const la = layer.has(a) ? /** @type {number} */ (layer.get(a)) : 1e9;
        const lb = layer.has(b) ? /** @type {number} */ (layer.get(b)) : 1e9;
        return la - lb || (lane.get(a) || 0) - (lane.get(b) || 0) || g.order(a) - g.order(b);
      });
      // Supply tree: from the outlets through ducts and junctions to the first equipment on each branch.
      /** @type {Map<string, string>} */
      const parent = new Map();
      /** @type {string[]} */
      const terminals = [];
      const treeNodes = [];
      const queue = outlets.map((o) => [o, null]);
      const seen = new Set(outlets);
      while (queue.length) {
        const [x, from] = /** @type {[string, string | null]} */ (queue.shift());
        for (const y of air.next(x)) {
          if (seen.has(y) || internal(y)) continue;
          if (isPass(g, y) && !air.next(y).some((z) => !internal(z))) continue;
          seen.add(y);
          parent.set(y, x);
          if (isPass(g, y)) { treeNodes.push(y); queue.push([y, x]); } else terminals.push(y);
        }
        void from;
      }
      const tree = {
        nodes: [...treeNodes, ...terminals].map((n) => ({ id: localId(n), iri: n, kind: isPass(g, n) ? kindOf(g, vocab, n) : 'terminal', label: g.label(n) || localId(n), props: propsOf(n) })),
        edges: [...parent.entries()].map(([child, from]) => [localId(from), localId(child)]),
      };
      const served = terminals.map((t) => {
        const tParts = containsClosure(g, t).map(node);
        // Space downstream of the terminal.
        let zone = null;
        const q = air.next(t);
        const s2 = new Set([t]);
        while (q.length && !zone) {
          const x = /** @type {string} */ (q.shift());
          if (s2.has(x)) continue;
          s2.add(x);
          if (SPACES.some((ty) => g.is(x, ty))) zone = x;
          else if (isPass(g, x)) q.push(...air.next(x));
        }
        const zoneOf = zone ? g.subjects('s223:hasDomainSpace', zone)[0] : null;
        return {
          ...node(t),
          parts: tParts,
          zone: zone ? { ...node(zone), zone: zoneOf ? { id: localId(zoneOf), label: g.label(zoneOf) || localId(zoneOf), props: propsOf(zoneOf) } : null } : null,
        };
      });
      // Parts off the air path (valves, pumps) attach to the part they connect to through any other medium.
      const linksOf = (/** @type {string} */ p) => {
        /** @type {string[]} */
        const found = [];
        for (const cpx of g.objects(p, 's223:hasConnectionPoint')) {
          for (const conn of g.objects(cpx, 's223:connectsThrough')) {
            for (const other of [...g.objects(conn, 's223:connectsAt'), ...g.subjects('s223:connectsThrough', conn)]) {
              for (const o of cpOwners(g, other)) if (o !== p && partSet.has(o) && !found.includes(localId(o))) found.push(localId(o));
            }
          }
        }
        return found;
      };
      return {
        ...node(ahu),
        parts: orderedParts.map((p) => ({ ...node(p), layer: layer.has(p) ? layer.get(p) : null, lane: lane.has(p) ? lane.get(p) : null, links: layer.has(p) ? [] : linksOf(p) })),
        edges: edges.map(([a, b]) => [localId(a), localId(b)]),
        outlets: outlets.map(localId),
        tree,
        terminals: served,
      };
    });
    const contained = new Set();
    for (const a of ahus) {
      contained.add(a.iri);
      for (const p of a.parts || []) contained.add(p.iri);
      for (const t of a.terminals || []) {
        contained.add(t.iri);
        for (const p of t.parts || []) contained.add(p.iri);
      }
    }
    const plantTypes = ['s223:Boiler', 's223:Chiller', 's223:Pump', 's223:CoolingTower'];
    /** @type {any[]} */
    const plants = [];
    const plantSeen = new Set();
    for (const typ of plantTypes) {
      for (const n of g.ofType(typ)) {
        if (contained.has(n) || plantSeen.has(n)) continue;
        plantSeen.add(n);
        const parts = containsClosure(g, n).filter((x) => x !== n).map(node);
        plants.push({ ...node(n), parts });
        contained.add(n);
        for (const p of parts) contained.add(p.iri);
      }
    }
    const terminalsAll = [];
    const seenTerm = new Set();
    for (const typ of ['s223:SingleDuctTerminal', 's223:FanPoweredTerminal', 's223:TerminalUnit']) {
      for (const n of g.ofType(typ)) {
        if (seenTerm.has(n)) continue;
        seenTerm.add(n);
        terminalsAll.push(n);
      }
    }
    const unassigned = terminalsAll.filter((n) => !contained.has(n)).map((n) => {
      contained.add(n);
      return { ...node(n), parts: containsClosure(g, n).filter((x) => x !== n).map(node), zone: null, unassigned: true };
    });
    const other = g.ofType('s223:Equipment').filter((n) => !contained.has(n)).map((n) => ({ ...node(n), parts: containsClosure(g, n).filter((x) => x !== n).map(node) }));

    if (!ahus.length) warnings.push('no s223:AirHandlingUnit in the model');
    return {
      triples: g.size,
      ahus,
      plants,
      unassigned,
      other,
      properties: { total: props.size, matched: props.size - unmatched.length - ambiguous.length, unmatched, ambiguous },
      warnings,
      // Simulation scenarios a demo model may carry (ext:simFault "kind:value" on a part). Ignored for live sites.
      scenarios: parsed.triples
        .filter((t) => /[#/]simFault$/.test(t.p) && t.o && typeof t.o === 'object')
        .map((t) => ({ part: localId(t.s), spec: String(t.o.value) })),
    };
  }

  /**
   * Every property in a discovered unit, flattened with its equipment path. Used by the sim, the controls
   * and the test generator, which only look at roles.
   * @param {any} unit one entry of discover().ahus
   */
  function points(unit) {
    /** @type {any[]} */
    const out = [];
    const push = (/** @type {any} */ n, /** @type {string} */ equipment, /** @type {string} */ scope) => {
      for (const p of n.props || []) out.push({ ...p, equipment, part: n.id, part_kind: n.kind, part_label: n.label, scope });
    };
    push(unit, unit.id, 'ahu');
    for (const p of unit.parts) push(p, unit.id, 'ahu');
    for (const n of unit.tree.nodes) if (n.kind !== 'terminal') push(n, unit.id, 'duct');
    for (const t of unit.terminals) {
      push(t, t.id, 'terminal');
      for (const p of t.parts) push(p, t.id, 'terminal');
      if (t.zone) {
        push(t.zone, t.id, 'zone');
        if (t.zone.zone) push(t.zone.zone, t.id, 'zone');
      }
    }
    return out;
  }

  /**
   * Flatten every property on every discovered system, plant and unassigned terminal.
   * @param {any} model discover() result
   */
  function allPoints(model) {
    /** @type {any[]} */
    const out = [];
    for (const a of (model && model.ahus) || []) out.push(...points(a));
    const pushEquip = (/** @type {any} */ e, /** @type {string} */ scope) => {
      if (!e) return;
      for (const p of e.props || []) out.push({ ...p, equipment: e.id, part: e.id, part_kind: e.kind, part_label: e.label, scope });
      for (const p of e.parts || []) {
        for (const q of p.props || []) out.push({ ...q, equipment: e.id, part: p.id, part_kind: p.kind, part_label: p.label, scope });
      }
    };
    for (const p of (model && model.plants) || []) pushEquip(p, 'plant');
    for (const t of (model && model.unassigned) || []) pushEquip(t, 'unassigned');
    for (const o of (model && model.other) || []) pushEquip(o, 'other');
    return out;
  }

  return { parseTurtle, fromQuads, prefixesOf, graph, discover, points, allPoints, matchRole, localId, KNOWN };
});
