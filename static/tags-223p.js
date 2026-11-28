/**
 * NF tags -> 223P. NF's Haystack tags are the source of truth; this derives the 223P view the graphic walks, and
 * nothing here is hand-edited or stored.
 *
 *   1. haystackFromTurtle: read the Haystack Turtle that Open-FDD's own modelToTurtle builds (served by the
 *      Open-FDD app when it is installed, or built here from NF records with the vendored copy of the same code).
 *   2. bind: every point to an Open-FDD role with the roles file's binding rules (static/haystack-bind.js).
 *   3. derive: emit each bound point as the 223P property its role's pattern describes, on the equipment,
 *      part and connection point that pattern names, and connect the parts in the 223P air-path order.
 *
 * Equipment and point names never appear in code: classes, roles and order come from the vocabulary.
 * Browser global NfftTags223p; CommonJS for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else /** @type {any} */ (root).NfftTags223p = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NS = {
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    ph: 'https://project-haystack.org/def/ph/',
    phIoT: 'https://project-haystack.org/def/phIoT/',
    phIct: 'https://project-haystack.org/def/phIct/',
    ref: 'https://brickschema.org/schema/Brick/ref#',
    brick: 'https://brickschema.org/schema/Brick#',
    s223: 'http://data.ashrae.org/standard223#',
    qudt: 'http://qudt.org/schema/qudt/',
    quantitykind: 'http://qudt.org/vocab/quantitykind/',
    unit: 'http://qudt.org/vocab/unit/',
    ext: 'urn:openfdd:ext#',
  };
  const TYPE = `${NS.rdf}type`;
  const LABEL = `${NS.rdfs}label`;
  const localName = (/** @type {string} */ iri) => { const m = /[#/:]([^#/:]+)$/.exec(iri); return m ? m[1] : iri; };
  /** CURIE (s223:Damper) to IRI, with the vocabulary's prefixes. */
  const expand = (/** @type {string} */ curie) => {
    const i = curie.indexOf(':');
    const ns = /** @type {any} */ (NS)[curie.slice(0, i)];
    return ns ? ns + curie.slice(i + 1) : curie;
  };

  /**
   * Equipment and points from a Haystack Turtle parse ({ triples, prefixes } as NfftS223.parseTurtle returns).
   * @param {{ triples: { s: string, p: string, o: any }[] }} parsed
   */
  function haystackFromTurtle(parsed) {
    /** @type {Map<string, Map<string, any[]>>} */
    const bySubject = new Map();
    for (const t of parsed.triples) {
      if (!bySubject.has(t.s)) bySubject.set(t.s, new Map());
      const m = /** @type {Map<string, any[]>} */ (bySubject.get(t.s));
      if (!m.has(t.p)) m.set(t.p, []);
      /** @type {any[]} */ (m.get(t.p)).push(t.o);
    }
    const get = (/** @type {string} */ s, /** @type {string} */ p) => (bySubject.get(s) || new Map()).get(p) || [];
    const lit = (/** @type {string} */ s, /** @type {string} */ p) => { const v = get(s, p)[0]; return v && typeof v === 'object' ? v.value : null; };
    const iris = (/** @type {string} */ s, /** @type {string} */ p) => get(s, p).filter((v) => typeof v === 'string');
    const local = (/** @type {string} */ s, /** @type {string} */ suffix) => {
      for (const [p, vs] of bySubject.get(s) || []) if (p.endsWith(`:${suffix}`) || p.endsWith(`/${suffix}`) || p.endsWith(`#${suffix}`)) return vs[0] && vs[0].value;
      return null;
    };
    const ofType = (/** @type {string} */ type) => [...bySubject.keys()].filter((s) => iris(s, TYPE).includes(type));
    const markers = (/** @type {string} */ s) => iris(s, `${NS.ph}hasTag`).map(localName);
    const equips = ofType(`${NS.phIoT}equip`).map((s) => ({
      iri: s,
      id: localName(s),
      label: lit(s, LABEL) || localName(s),
      markers: markers(s),
      airRef: iris(s, `${NS.phIoT}airRef`),
      feeds: iris(s, `${NS.brick}feeds`),
      isFedBy: iris(s, `${NS.brick}isFedBy`),
    }));
    const points = ofType(`${NS.phIoT}point`).map((s) => {
      const refs = iris(s, `${NS.ref}hasExternalReference`);
      const uuid = refs.map((r) => lit(r, `${NS.ref}hasTimeseriesId`)).find(Boolean) || localName(s);
      return {
        iri: s,
        id: localName(s),
        uuid,
        label: lit(s, LABEL) || localName(s),
        markers: markers(s),
        cls: local(s, 'nfClass') || '',
        unit: lit(s, `${NS.ph}unit`),
        equip: iris(s, `${NS.phIoT}equipRef`)[0] || null,
      };
    });
    return { equips, points };
  }

  // 223P air-path order inside an air handler, by class and role (terms of the standard, not equipment names).
  const AIR_ORDER = [
    { cls: 's223:Damper', role: 's223:Role-OutdoorAirIntake', layer: 0 },
    { cls: 's223:Damper', role: 's223:Role-Return', layer: 0 },
    { cls: 's223:Junction', role: null, layer: 1, mixing: true },
    { cls: 's223:Filter', role: null, layer: 2 },
    { cls: 's223:HeatingCoil', role: 'ext:Preheat', layer: 3 },
    { cls: 's223:CoolingCoil', role: null, layer: 4 },
    { cls: 's223:HeatingCoil', role: null, layer: 5 },
    { cls: 's223:Fan', role: 's223:Role-Supply', layer: 6 },
  ];
  // A valve serves the coil of its duty (water side).
  const VALVE_COIL = { 's223:Role-Cooling': 's223:CoolingCoil', 's223:Role-Heating': 's223:HeatingCoil' };
  const WATER = { 's223:Role-Cooling': 's223:Water-ChilledWater', 's223:Role-Heating': 's223:Water-HotWater' };

  /**
   * Derive the 223P triples.
   * @param {{ equips: any[], points: any[] }} hs
   * @param {any} vocab NfftRoles223p
   * @param {any} bind NfftHaystackBind
   */
  function derive(hs, vocab, bind) {
    /** @type {{ s: string, p: string, o: any }[]} */
    const triples = [];
    const add = (/** @type {string} */ s, /** @type {string} */ p, /** @type {any} */ o) => triples.push({ s, p: expand(p), o: typeof o === 'string' ? expand(o) : o });
    const label = (/** @type {string} */ s, /** @type {string} */ text) => triples.push({ s, p: LABEL, o: { value: text, datatype: null, lang: null } });
    const warnings = [];
    const roleDef = new Map(vocab.roles.map((/** @type {any} */ r) => [r.role, r]));
    const equipByIri = new Map(hs.equips.map((e) => [e.iri, e]));
    const isAhu = (/** @type {any} */ e) => e.markers.includes('ahu');
    const isTerminal = (/** @type {any} */ e) => e.markers.includes('airTerminalUnit') || e.markers.includes('vav');
    const isBoiler = (/** @type {any} */ e) => e.markers.includes('boiler');
    const isChiller = (/** @type {any} */ e) => e.markers.includes('chiller');
    const isPump = (/** @type {any} */ e) => e.markers.includes('pump');
    const isTower = (/** @type {any} */ e) => e.markers.includes('coolingTower');
    const classOf = (/** @type {any} */ e) => {
      if (isAhu(e)) return 's223:AirHandlingUnit';
      if (isTerminal(e)) return 's223:SingleDuctTerminal';
      if (isBoiler(e)) return 's223:Boiler';
      if (isChiller(e)) return 's223:Chiller';
      if (isPump(e)) return 's223:Pump';
      if (isTower(e)) return 's223:CoolingTower';
      return 's223:Equipment';
    };
    /** @type {any[]} */
    const bindings = [];
    const report = { unbound: /** @type {string[]} */ ([]), ambiguous: /** @type {any[]} */ ([]), duplicates: /** @type {any[]} */ ([]) };
    let cpCount = 0;

    // Equipment classes and feeds (airRef on the terminal, or brick feeds / isFedBy).
    // Unknown equipment is typed s223:Equipment so the graphic can draw a generic box.
    for (const e of hs.equips) {
      add(e.iri, 'rdf:type', classOf(e));
      // 223P patterns often apply_to s223:TerminalUnit; a single-duct box is one.
      if (isTerminal(e)) add(e.iri, 'rdf:type', 's223:TerminalUnit');
      label(e.iri, e.label);
    }
    /** @type {Map<string, string[]>} ahu iri -> terminal iris */
    const served = new Map();
    for (const t of hs.equips.filter(isTerminal)) {
      const feeders = [...t.airRef, ...t.isFedBy, ...hs.equips.filter((a) => a.feeds.includes(t.iri)).map((a) => a.iri)]
        .filter((iri, i, all) => all.indexOf(iri) === i && equipByIri.has(iri) && isAhu(equipByIri.get(iri)));
      if (feeders.length === 1) {
        if (!served.has(feeders[0])) served.set(feeders[0], []);
        /** @type {string[]} */ (served.get(feeders[0])).push(t.iri);
      } else warnings.push(`${t.label}: ${feeders.length ? 'more than one feeding air handler' : 'no airRef to an air handler'}`);
    }

    /** @type {Map<string, Map<string, string>>} equip iri -> part key -> part iri */
    const parts = new Map();
    const partOf = (/** @type {string} */ top, /** @type {string} */ cls, /** @type {string|null} */ role, /** @type {string} */ what) => {
      if (!parts.has(top)) parts.set(top, new Map());
      const m = /** @type {Map<string, string>} */ (parts.get(top));
      const key = `${cls}|${role || ''}`;
      if (!m.has(key)) {
        const iri = `${top}--${localName(expand(cls)).toLowerCase()}${role ? `-${localName(expand(role)).replace(/^Role-/, '').toLowerCase()}` : ''}`;
        add(iri, 'rdf:type', cls);
        if (role) add(iri, 's223:hasRole', role);
        add(top, 's223:contains', iri);
        label(iri, what);
        m.set(key, iri);
      }
      return /** @type {string} */ (m.get(key));
    };
    const cp = (/** @type {string} */ owner, /** @type {string} */ kind, /** @type {string} */ medium, /** @type {string[]} */ roles = []) => {
      cpCount += 1;
      const iri = `${owner}--cp${cpCount}`;
      add(iri, 'rdf:type', kind === 'in' ? 's223:InletConnectionPoint' : 's223:OutletConnectionPoint');
      add(iri, 's223:isConnectionPointOf', owner);
      add(owner, 's223:hasConnectionPoint', iri);
      add(iri, 's223:hasMedium', medium);
      for (const r of roles) add(iri, 's223:hasRole', r);
      return iri;
    };
    let ductCount = 0;
    const connect = (/** @type {string} */ a, /** @type {string} */ b, /** @type {string} */ medium = 's223:Fluid-Air', /** @type {string} */ cls = 's223:Duct') => {
      ductCount += 1;
      const iri = `urn:nfft:derived:${cls === 's223:Pipe' ? 'pipe' : 'duct'}${ductCount}`;
      add(iri, 'rdf:type', cls);
      add(iri, 's223:hasMedium', medium);
      add(iri, 's223:connectsAt', a);
      add(iri, 's223:connectsAt', b);
      add(a, 's223:connectsThrough', iri);
      add(b, 's223:connectsThrough', iri);
      return iri;
    };
    /** @type {Map<string, string>} terminal iri -> its space */
    const spaces = new Map();
    const spaceOf = (/** @type {any} */ t) => {
      if (!spaces.has(t.iri)) {
        const iri = `${t.iri}--space`;
        add(iri, 'rdf:type', 's223:DomainSpace');
        label(iri, `${t.label} zone`);
        const zone = `${t.iri}--zone`;
        add(zone, 'rdf:type', 's223:Zone');
        add(zone, 's223:hasDomainSpace', iri);
        label(zone, `${t.label} zone`);
        spaces.set(t.iri, iri);
      }
      return /** @type {string} */ (spaces.get(t.iri));
    };

    // Bind and emit every point of every modelled equipment (AHU, terminal, plant, unknown).
    const relevant = hs.equips;
    for (const e of relevant) {
      const pts = hs.points.filter((p) => p.equip === e.iri);
      const r = bind.bindEquipment(pts, e.markers, vocab);
      report.unbound.push(...r.unbound);
      report.ambiguous.push(...r.ambiguous);
      report.duplicates.push(...r.duplicates);
      for (const p of pts) {
        const role = r.bound[p.id];
        if (!role) continue;
        const def = roleDef.get(role);
        const pat = def.s223 || {};
        const zoneScoped = pat.scope === 's223:Zone' || (pat.applies_to || []).some((/** @type {string} */ a) => /Zone$|DomainSpace$/.test(a));
        let owner = e.iri;
        if (zoneScoped && isTerminal(e)) owner = spaceOf(e);
        else if (zoneScoped) { warnings.push(`${p.label}: zone point on an air handler, not placed`); continue; }
        if (pat.equipment) {
          // If the top equipment already is that class (a standalone boiler, pump, chiller), hang the property on it.
          if (classOf(e) === pat.equipment) owner = e.iri;
          else {
            owner = partOf(e.iri, pat.equipment, pat.equipment_role || null, `${e.label} ${localName(expand(pat.equipment)).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}`);
          }
          if (pat.equipment_medium) cp(owner, 'in', pat.equipment_medium);
        }
        add(p.iri, 'rdf:type', pat.property_class || 's223:Property');
        label(p.iri, p.label);
        if (pat.quantity_kind) add(p.iri, 'qudt:hasQuantityKind', pat.quantity_kind);
        if (pat.enumeration_kind) add(p.iri, 's223:hasEnumerationKind', pat.enumeration_kind);
        for (const a of pat.aspects || []) add(p.iri, 's223:hasAspect', a);
        if (pat.qualifier) add(p.iri, 's223:hasAspect', pat.qualifier);
        if (pat.constituent) add(p.iri, 's223:ofConstituent', pat.constituent);
        if (pat.medium) add(p.iri, 's223:ofMedium', pat.medium);
        if (def.unit) add(p.iri, 'qudt:hasUnit', def.unit);
        triples.push({ s: p.iri, p: `${NS.ext}nfPoint`, o: { value: p.uuid, datatype: null, lang: null } });
        if (pat.connection_point) {
          const at = cp(owner, /Inlet/.test(pat.connection_point) ? 'in' : 'out', pat.medium || 's223:Fluid-Air', pat.roles || []);
          add(at, 's223:hasProperty', p.iri);
        } else {
          for (const x of pat.roles || []) add(p.iri, 's223:hasAspect', x);
          add(owner, 's223:hasProperty', p.iri);
        }
        bindings.push({ point: p.id, uuid: p.uuid, label: p.label, role, equipment: e.id });
      }
    }

    // Valves imply the coil of their duty; coils and valves are joined on the water side.
    for (const [top, m] of parts) {
      for (const [key, valve] of [...m.entries()]) {
        const [cls, role] = key.split('|');
        if (cls !== 's223:Valve' || !(/** @type {any} */ (VALVE_COIL)[role])) continue;
        const coil = partOf(top, /** @type {any} */ (VALVE_COIL)[role], null, `${equipByIri.get(top).label} ${role === 's223:Role-Cooling' ? 'cooling' : 'heating'} coil`);
        connect(cp(valve, 'out', /** @type {any} */ (WATER)[role]), cp(coil, 'in', /** @type {any} */ (WATER)[role]), /** @type {any} */ (WATER)[role], 's223:Pipe');
      }
    }

    // Air path: AHU parts in 223P order, then the supply trunk to every terminal it serves, then each space.
    for (const ahu of hs.equips.filter(isAhu)) {
      const m = parts.get(ahu.iri) || new Map();
      const has = (/** @type {any} */ o) => m.has(`${o.cls}|${o.role || ''}`);
      const intakes = AIR_ORDER.filter((o) => o.layer === 0 && has(o));
      if (intakes.length > 1) partOf(ahu.iri, 's223:Junction', null, `${ahu.label} mixing`);
      const chain = AIR_ORDER.filter((o) => o.layer > 0 && has(o)).map((o) => /** @type {string} */ (m.get(`${o.cls}|${o.role || ''}`)));
      const first = chain[0];
      for (const o of intakes) {
        const d = /** @type {string} */ (m.get(`${o.cls}|${o.role || ''}`));
        const inlet = cp(d, 'in', 's223:Fluid-Air');
        add(inlet, 's223:mapsTo', cp(ahu.iri, 'in', 's223:Fluid-Air', [o.role]));
        if (first) connect(cp(d, 'out', 's223:Fluid-Air'), cp(first, 'in', 's223:Fluid-Air'));
      }
      for (let i = 1; i < chain.length; i += 1) connect(cp(chain[i - 1], 'out', 's223:Fluid-Air'), cp(chain[i], 'in', 's223:Fluid-Air'));
      const last = chain[chain.length - 1] || (intakes.length === 1 ? m.get(`${intakes[0].cls}|${intakes[0].role || ''}`) : null);
      const terminals = served.get(ahu.iri) || [];
      if (!last) { if (terminals.length) warnings.push(`${ahu.label}: no air-path parts bound, terminals not connected`); continue; }
      const outlet = cp(last, 'out', 's223:Fluid-Air');
      add(cp(ahu.iri, 'out', 's223:Fluid-Air', ['s223:Role-Discharge']), 's223:mapsTo', outlet);
      if (!terminals.length) continue;
      const split = `${ahu.iri}--supply-split`;
      add(split, 'rdf:type', 's223:Junction');
      label(split, `${ahu.label} supply split`);
      connect(outlet, cp(split, 'in', 's223:Fluid-Air'));
      for (const tIri of terminals) {
        const t = equipByIri.get(tIri);
        const tin = cp(tIri, 'in', 's223:Fluid-Air');
        connect(cp(split, 'out', 's223:Fluid-Air'), tin);
        const tout = cp(tIri, 'out', 's223:Fluid-Air', ['s223:Role-Discharge']);
        connect(tout, cp(spaceOf(t), 'in', 's223:Fluid-Air'));
      }
    }
    // Hydronic plants: connect a site's boiler / pump to heating coils, chiller / CHW pump to cooling coils.
    // Prefer explicit feeds / isFedBy; if the site has exactly one plant of that medium, serve every matching coil.
    const coilIris = (/** @type {string} */ cls) => {
      /** @type {string[]} */
      const found = [];
      for (const t of triples) {
        if (t.p === TYPE && t.o === expand(cls)) found.push(t.s);
      }
      return found;
    };
    const mediaOf = (/** @type {any} */ e) => {
      if (isBoiler(e) || (isPump(e) && (e.markers.includes('hot') || e.markers.includes('hotWater')))) return 's223:Water-HotWater';
      if (isChiller(e) || (isPump(e) && (e.markers.includes('chilled') || e.markers.includes('chilledWater')))) return 's223:Water-ChilledWater';
      if (isPump(e)) return e.markers.includes('condenser') ? 's223:Water-Condenser' : 's223:Water-HotWater';
      return null;
    };
    const fedBy = (/** @type {any} */ plant, /** @type {string[]} */ coils) => {
      const named = [...plant.feeds, ...hs.equips.filter((a) => a.isFedBy.includes(plant.iri)).map((a) => a.iri)];
      if (!named.length) return coils;
      const want = new Set(named);
      // A plant that feeds an AHU or terminal serves the coils contained by that equipment.
      const served = coils.filter((c) => [...want].some((iri) => c === iri || c.startsWith(`${iri}--`)));
      return served.length ? served : coils;
    };
    const hookup = (/** @type {any[]} */ plants, /** @type {string} */ coilCls, /** @type {string} */ medium) => {
      const coils = coilIris(coilCls);
      if (!plants.length || !coils.length) return;
      const unique = plants.length === 1 ? plants : plants;
      for (const plant of unique) {
        const targets = plants.length === 1 ? coils : fedBy(plant, coils);
        if (!targets.length) {
          warnings.push(`${plant.label}: no ${medium} coils to connect`);
          continue;
        }
        const supply = cp(plant.iri, 'out', medium, ['s223:Role-Supply']);
        const ret = cp(plant.iri, 'in', medium, ['s223:Role-Return']);
        for (const coil of targets) {
          connect(supply, cp(coil, 'in', medium, ['s223:Role-Supply']), medium, 's223:Pipe');
          connect(cp(coil, 'out', medium, ['s223:Role-Return']), ret, medium, 's223:Pipe');
        }
      }
    };
    hookup(hs.equips.filter((e) => mediaOf(e) === 's223:Water-HotWater' && (isBoiler(e) || isPump(e))), 's223:HeatingCoil', 's223:Water-HotWater');
    hookup(hs.equips.filter((e) => mediaOf(e) === 's223:Water-ChilledWater' && (isChiller(e) || isPump(e))), 's223:CoolingCoil', 's223:Water-ChilledWater');

    const prefixes = { s223: NS.s223, qudt: NS.qudt, quantitykind: NS.quantitykind, unit: NS.unit, rdfs: NS.rdfs, ext: NS.ext };
    return { parsed: { triples, prefixes }, bindings, report, warnings };
  }

  /**
   * Haystack Turtle -> discovered graphic model, with the binding report.
   * @param {string} turtle
   * @param {{ oxigraph: any, s223: any, vocab: any, bind: any, scenarios?: { equip: string, part: string, spec: string }[] }} deps
   */
  function buildModel(turtle, deps) {
    const hs = haystackFromTurtle(deps.s223.parseTurtle(deps.oxigraph, turtle));
    const d = derive(hs, deps.vocab, deps.bind);
    const discovered = deps.s223.discover(d.parsed, deps.vocab);
    // Demo scenarios name an equipment by its NF uuid and a part by its 223P class.
    const scenarios = (deps.scenarios || []).map((x) => {
      const equip = hs.equips.find((e) => e.id === x.equip);
      return equip ? { part: localName(`${equip.iri}--${localName(expand(x.part)).toLowerCase()}`), spec: x.spec } : null;
    }).filter(Boolean);
    return { ...discovered, scenarios: [...discovered.scenarios, ...scenarios], bindings: d.bindings, report: d.report, warnings: [...d.warnings, ...discovered.warnings] };
  }

  return { haystackFromTurtle, derive, buildModel, AIR_ORDER, NS };
});
