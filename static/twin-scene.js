// Digital twin 3D scene: draws a layout from NfftTwin.layout (built from the 223P model) and animates it from
// sim or replay frames. Procedural geometry only, three.js r170 vendored in static/vendor/three. Display only:
// nothing here reads or writes NF. Loaded with a dynamic import when the twin tab first opens.
import * as THREE from './vendor/three/three.module.min.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';

const C = {
  bg: 0x0b1020, panel: 0x121a30, line: 0x24304f, text: 0xe6ebf5, muted: 0x8a96b3, accent: 0x4cc9f0,
  warm: 0xf8961e, hot: 0xf94144, cool: 0x4361ee, good: 0x43aa8b, metal: 0x5b6785, amber: 0xffb703,
};

const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.55, ...o });
const glass = (color, opacity) => new THREE.MeshStandardMaterial({ color, transparent: true, opacity, depthWrite: false, roughness: 0.2, metalness: 0.1, side: THREE.DoubleSide });
const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

/** Outline box around an element, hidden until it is overridden (amber) or faulted (red). */
function outline(size) {
  const g = new THREE.EdgesGeometry(new THREE.BoxGeometry(size[0] + 0.25, size[1] + 0.25, size[2] + 0.25));
  const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: C.amber, transparent: true, opacity: 0.95 }));
  l.visible = false;
  return l;
}

/** Louvre damper: frame plus blades rotating about z (0% = closed across the air, 100% = open). */
function damper(size, blades = 4) {
  const g = new THREE.Group();
  const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(0.12, size[1], size[2])), new THREE.LineBasicMaterial({ color: C.metal }));
  g.add(frame);
  const list = [];
  const h = size[1] / blades;
  for (let i = 0; i < blades; i += 1) {
    const pivot = new THREE.Group();
    pivot.position.y = -size[1] / 2 + h * (i + 0.5);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.04, h * 0.95, size[2] * 0.96), mat(0x9aa7c7));
    pivot.add(blade);
    g.add(pivot);
    list.push(pivot);
  }
  g.userData.set = (pct) => { for (const p of list) p.rotation.z = (Math.PI / 2) * (pct / 100); };
  return g;
}

/** Finned coil whose fins glow with its valve command. */
function coil(size, hue) {
  const g = new THREE.Group();
  const fins = new THREE.Group();
  const m = mat(0x6b7690, { emissive: hue, emissiveIntensity: 0 });
  for (let i = 0; i < 9; i += 1) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(0.03, size[1] * 0.92, size[2] * 0.92), m);
    f.position.x = -size[0] / 2 + (size[0] / 8) * i;
    fins.add(f);
  }
  g.add(fins);
  const tube = new THREE.Mesh(new THREE.TorusGeometry(size[1] * 0.38, 0.03, 8, 32), mat(hue, { emissive: hue, emissiveIntensity: 0.2 }));
  tube.rotation.y = Math.PI / 2;
  g.add(tube);
  g.userData.set = (pct) => { m.emissiveIntensity = 0.05 + 1.1 * (pct / 100); m.color.setHex(pct > 2 ? hue : 0x6b7690); };
  return g;
}

/** Plug fan: housing ring and a rotor spun by speed. */
function fan(size) {
  const g = new THREE.Group();
  const r = Math.min(size[1], size[2]) * 0.42;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.06, 12, 40), mat(C.metal));
  ring.rotation.y = Math.PI / 2;
  g.add(ring);
  const rotor = new THREE.Group();
  for (let i = 0; i < 7; i += 1) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.05, r * 0.9, 0.16), mat(0xb8c2dc));
    b.position.y = r * 0.45;
    const arm = new THREE.Group();
    arm.add(b);
    arm.rotation.x = (i / 7) * Math.PI * 2;
    b.rotation.y = 0.5;
    rotor.add(arm);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.2, 16), mat(C.accent, { emissive: C.accent, emissiveIntensity: 0.3 }));
  hub.rotation.z = Math.PI / 2;
  rotor.add(hub);
  g.add(rotor);
  g.userData.rotor = rotor;
  return g;
}

function filterBank(size) {
  const g = new THREE.Group();
  for (let i = 0; i < 6; i += 1) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.02, size[1] * 0.9, size[2] * 0.9), mat(0xc9d2e8, { roughness: 0.9 }));
    p.position.x = (i - 2.5) * 0.08;
    p.rotation.y = i % 2 ? 0.35 : -0.35;
    g.add(p);
  }
  return g;
}

function valve(hue) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.16, 20, 14), mat(hue, { emissive: hue, emissiveIntensity: 0.1 }));
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 8), mat(C.metal));
  stem.position.y = 0.25;
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.22), mat(0x30395a));
  cap.position.y = 0.48;
  g.add(body, stem, cap);
  g.userData.set = (pct) => { body.material.emissiveIntensity = 0.1 + pct / 100; cap.rotation.y = (pct / 100) * Math.PI / 2; };
  return g;
}

/** Duct segment between two points, coloured by static pressure. */
function duct(from, to, radius) {
  const a = v3(from), b = v3(to);
  const len = a.distanceTo(b);
  const m = glass(C.good, 0.3);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 24, 1, true), m);
  mesh.position.copy(a.clone().add(b).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.CylinderGeometry(radius, radius, len, 12, 1, true), 30), new THREE.LineBasicMaterial({ color: C.line, transparent: true, opacity: 0.6 }));
  edge.position.copy(mesh.position);
  edge.quaternion.copy(mesh.quaternion);
  const g = new THREE.Group();
  g.add(mesh, edge);
  g.userData.paint = (rgb) => { m.color.setRGB(rgb[0], rgb[1], rgb[2]); };
  return g;
}

/** Particles along a polyline; speed and density follow airflow. */
function particles(path, count, color) {
  const pts = path.map(v3);
  const lens = [];
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) { const l = pts[i].distanceTo(pts[i - 1]); lens.push(l); total += l; }
  const pos = new Float32Array(count * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({ color, size: 0.09, transparent: true, opacity: 0.9, depthWrite: false });
  const obj = new THREE.Points(geo, m);
  const u = Array.from({ length: count }, (_, i) => i / count);
  const jitter = Array.from({ length: count }, (_, i) => [Math.sin(i * 12.9898) * 0.12, Math.cos(i * 78.233) * 0.12]);
  const at = (t, out, j) => {
    let d = t * total;
    let k = 0;
    while (k < lens.length - 1 && d > lens[k]) { d -= lens[k]; k += 1; }
    out.copy(pts[k]).lerp(pts[k + 1], Math.min(1, d / (lens[k] || 1)));
    out.y += j[0];
    out.z += j[1];
  };
  const tmp = new THREE.Vector3();
  obj.userData.step = (dt, share) => {
    const visible = Math.round(count * Math.max(0, Math.min(1, share)));
    geo.setDrawRange(0, visible);
    const speed = 0.05 + 0.35 * share;
    for (let i = 0; i < count; i += 1) {
      u[i] = (u[i] + dt * speed) % 1;
      at(u[i], tmp, jitter[i]);
      pos[i * 3] = tmp.x; pos[i * 3 + 1] = tmp.y; pos[i * 3 + 2] = tmp.z;
    }
    geo.attributes.position.needsUpdate = true;
  };
  return obj;
}

/**
 * @param {HTMLElement} host element to draw into (gets a canvas and a label layer)
 * @param {any} layout NfftTwin.layout(unit, points)
 * @param {{ pressureColor: (pa: number, limit: number) => number[], staticLimitPa: number, preserveDrawingBuffer?: boolean }} opts
 */
export function createTwinScene(host, layout, opts) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: !!opts.preserveDrawingBuffer });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(C.bg, 1);
  host.appendChild(renderer.domElement);
  const labels = document.createElement('div');
  labels.className = 'twin-labels';
  host.appendChild(labels);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(C.bg, 30, 70);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  const center = v3(layout.center);
  camera.position.set(center.x - 2.5, 8.5, center.z + 13);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;

  scene.add(new THREE.HemisphereLight(0xb8c7ff, 0x0b1020, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(-6, 14, 10);
  scene.add(sun);
  const grid = new THREE.GridHelper(80, 80, C.line, 0x162040);
  grid.position.set(center.x, -1.05, center.z);
  scene.add(grid);

  // Air handler casing: back-face glass so the front is cut away.
  const cs = layout.casing;
  const size = [cs.to[0] - cs.from[0], cs.to[1] - cs.from[1], cs.to[2] - cs.from[2]];
  const casing = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), new THREE.MeshStandardMaterial({ color: C.panel, transparent: true, opacity: 0.35, side: THREE.BackSide, depthWrite: false }));
  casing.position.set((cs.from[0] + cs.to[0]) / 2, 0, (cs.from[2] + cs.to[2]) / 2);
  const casingEdges = new THREE.LineSegments(new THREE.EdgesGeometry(casing.geometry), new THREE.LineBasicMaterial({ color: C.accent, transparent: true, opacity: 0.45 }));
  casingEdges.position.copy(casing.position);
  scene.add(casing, casingEdges);

  const objects = new Map();
  const outlines = new Map();
  /** @type {{ el: HTMLElement, at: any, id: string }[]} */
  const tags = [];
  const tag = (id, text, at, cls = '') => {
    const el = document.createElement('div');
    el.className = `twin-tag ${cls}`;
    el.textContent = text;
    labels.appendChild(el);
    tags.push({ el, at: v3(at), id });
    return el;
  };
  tag(cs.id, cs.label, [casing.position.x, cs.to[1] + 0.6, casing.position.z], 'unit');

  for (const e of layout.elements) {
    let obj;
    if (e.kind === 'damper') obj = damper(e.size);
    else if (e.kind === 'cooling_coil') obj = coil(e.size, C.cool);
    else if (/heating_coil|coil/.test(e.kind)) obj = coil(e.size, C.hot);
    else if (e.kind === 'fan') obj = fan(e.size);
    else if (e.kind === 'filter') obj = filterBank(e.size);
    else if (e.kind === 'valve') obj = valve(/cool/i.test(e.label) || (layout.elements.find((x) => x.id === e.host) || {}).kind === 'cooling_coil' ? C.cool : C.hot);
    else obj = new THREE.Mesh(new THREE.BoxGeometry(e.size[0], e.size[1], e.size[2]), glass(C.metal, 0.12));
    obj.position.set(e.pos[0], e.pos[1], e.pos[2]);
    scene.add(obj);
    objects.set(e.id, obj);
    const o = outline(e.size);
    o.position.copy(obj.position);
    scene.add(o);
    outlines.set(e.id, o);
    if (e.host) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.0, 8), mat(C.metal));
      pipe.position.set(e.pos[0], 0.7, e.pos[2]);
      scene.add(pipe);
    }
  }

  // Ducts.
  const ducts = layout.ducts.map((d) => {
    const g = duct(d.from, d.to, d.radius);
    scene.add(g);
    return { ...d, g };
  });

  // Terminals: box, round damper blade, reheat coil plate, valve, served space.
  const terms = layout.terminals.map((t) => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.75, 1.3), glass(C.metal, 0.16));
    box.position.copy(v3(t.box));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), new THREE.LineBasicMaterial({ color: C.accent, transparent: true, opacity: 0.5 }));
    edges.position.copy(box.position);
    const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.03, 28), mat(0x9aa7c7));
    const pivot = new THREE.Group();
    pivot.position.copy(v3(t.box)).add(new THREE.Vector3(0, 0, -0.35));
    pivot.add(blade);
    blade.rotation.x = Math.PI / 2;
    const rh = coil([0.5, 0.6, 0.06], C.hot);
    rh.rotation.y = Math.PI / 2;
    rh.position.copy(v3(t.box)).add(new THREE.Vector3(0, 0, 0.35));
    const vl = valve(C.hot);
    vl.scale.setScalar(0.7);
    vl.position.copy(v3(t.box)).add(new THREE.Vector3(0.55, 0.3, 0.35));
    const floor = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.08, 2.0), mat(C.good, { transparent: true, opacity: 0.55, emissive: C.good, emissiveIntensity: 0.15 }));
    floor.position.copy(v3(t.zonePos));
    scene.add(box, edges, pivot, rh, vl, floor);
    const o = outline([0.9, 0.75, 1.3]);
    o.position.copy(box.position);
    scene.add(o);
    if (t.damper) outlines.set(t.damper, o);
    const vo = outline([0.3, 0.6, 0.3]);
    vo.position.copy(vl.position);
    scene.add(vo);
    if (t.valve) outlines.set(t.valve, vo);
    const flow = particles(t.path, 90, C.accent);
    scene.add(flow);
    const name = tag(t.id, t.label, [t.box[0], t.box[1] + 0.85, t.box[2]], 'terminal');
    const read = tag(`${t.id}:read`, '', [t.box[0], t.box[1] - 0.75, t.box[2]], 'read');
    const zone = t.zone ? tag(`${t.id}:zone`, t.zone.label, [t.zonePos[0], t.zonePos[1] + 0.2, t.zonePos[2] + 1.2], 'zone') : null;
    return { t, pivot, rh, vl, floor, flow, name, read, zone };
  });
  const intakes = layout.intakes.map((i) => {
    const p = particles(i.path, 60, C.muted);
    scene.add(p);
    return { ...i, p };
  });
  const unitRead = tag(`${cs.id}:read`, '', [casing.position.x, cs.from[1] - 0.45, cs.to[2] + 0.2], 'read');

  /** @type {any} */
  let state = null;
  /** @type {Set<string>} */
  let amber = new Set();
  /** @type {Set<string>} */
  let red = new Set();
  const fmt = (v, d = 0) => ((v ?? null) === null || Number.isNaN(v) ? '—' : Number(v).toFixed(d));

  function apply() {
    if (!state) return;
    const s = state.scene;
    for (const e of layout.elements) {
      const obj = objects.get(e.id);
      if (!obj || !obj.userData.set) continue;
      const v = e.command && (state.values[e.command] ?? null) !== null ? Number(state.values[e.command]) : 0;
      obj.userData.set(v);
    }
    for (const d of ducts) {
      let pa = s.staticPa;
      if ((d.terminal ?? null) !== null) {
        const ts = s.terminals[d.terminal];
        pa = d.id.startsWith('drop_') ? s.staticPa * 0.25 * (ts.flowLps / (ts.maxLps || 1)) : s.staticPa * 0.92;
      }
      d.g.userData.paint(opts.pressureColor(pa, opts.staticLimitPa));
    }
    for (const x of terms) {
      const ts = s.terminals[x.t.index];
      x.pivot.rotation.y = 0;
      x.pivot.children[0].rotation.y = (Math.PI / 2) * (ts.blade / 100);
      x.rh.userData.set(ts.reheat);
      x.vl.userData.set(ts.reheat);
      const warmth = Math.max(-1, Math.min(1, (ts.zoneTemp - 23) / 2.5));
      x.floor.material.color.setHex(warmth > 0.35 ? C.warm : warmth < -0.35 ? C.cool : C.good);
      x.read.textContent = `${fmt(ts.flowLps)} L/s · cmd ${fmt(ts.command)}% · fb ${fmt(ts.feedback)}%`;
      if (x.zone) x.zone.textContent = `${x.t.zone.label} ${fmt(ts.zoneTemp, 1)} °C`;
    }
    unitRead.textContent = `fan ${fmt(s.fanSpeed)}% · ${fmt(s.staticPa)} Pa · SAT ${fmt(s.sat, 1)} °C · OA ${fmt(s.oaFraction * 100)}%`;
    for (const [id, o] of outlines) {
      const isRed = red.has(id);
      const isAmber = amber.has(id);
      o.visible = isRed || isAmber;
      o.material.color.setHex(isRed ? C.hot : C.amber);
    }
  }

  let last = performance.now();
  let raf = 0;
  let disposed = false;
  function frame(now) {
    if (disposed) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (state) {
      const s = state.scene;
      for (const e of layout.elements) {
        const obj = objects.get(e.id);
        if (obj && obj.userData.rotor) obj.userData.rotor.rotation.x += dt * (s.fanOn ? s.fanSpeed / 100 : 0) * 14;
      }
      for (const x of terms) {
        const ts = s.terminals[x.t.index];
        x.flow.userData.step(dt, ts.flowLps / Math.max(1, ts.maxLps));
      }
      const totalMax = s.terminals.reduce((a, t) => a + t.maxLps, 0) || 1;
      for (const i of intakes) {
        const e = layout.elements.find((x) => x.id === i.part);
        const pct = e && e.command && (state.values[e.command] ?? null) !== null ? Number(state.values[e.command]) / 100 : 0.5;
        i.p.userData.step(dt, (s.totalLps / totalMax) * pct);
      }
    }
    controls.update();
    renderer.render(scene, camera);
    const w = renderer.domElement.clientWidth;
    const h = renderer.domElement.clientHeight;
    const p = new THREE.Vector3();
    for (const t of tags) {
      p.copy(t.at).project(camera);
      const hidden = p.z > 1;
      t.el.style.display = hidden ? 'none' : '';
      t.el.style.transform = `translate(-50%, -50%) translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h}px)`;
    }
    raf = requestAnimationFrame(frame);
  }

  function resize() {
    const w = host.clientWidth || 800;
    const h = host.clientHeight || 480;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = `${w}px`;
    renderer.domElement.style.height = `${h}px`;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(host);
  raf = requestAnimationFrame(frame);

  return {
    /** @param {any} frameState { values, scene } @param {{ overridden?: string[], faulted?: string[] }} marks part ids */
    update(frameState, marks = {}) {
      state = frameState;
      amber = new Set(marks.overridden || []);
      red = new Set(marks.faulted || []);
      apply();
    },
    resize,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      controls.dispose();
      renderer.dispose();
      host.innerHTML = '';
    },
  };
}
