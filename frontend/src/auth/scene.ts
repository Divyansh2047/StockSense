/**
 * Sign-in backdrop: crates drop onto a pallet one by one and stack up, then the
 * top crate lifts off and floats. Loaded lazily so three.js never lands in the
 * main bundle.
 */
import * as THREE from 'three';

interface Palette {
  floor: number;
  crate: number;
  pallet: number;
  edge: number;
  edgeOpacity: number;
  hemi: number;
  key: number;
}
const PAL: Record<'dark' | 'light', Palette> = {
  dark: { floor: 0x15181a, crate: 0xd9dcde, pallet: 0x353b40, edge: 0x0c0e0f, edgeOpacity: 0.6, hemi: 0.75, key: 2.4 },
  light: { floor: 0xe3e6e8, crate: 0xffffff, pallet: 0x5a6168, edge: 0x2e3439, edgeOpacity: 0.35, hemi: 1.15, key: 2.3 },
};

function crateTexture(label: string) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#dfe2e4';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = 'rgba(0,0,0,0.05)';
  for (let y = 0; y < 256; y += 16) g.fillRect(0, y, 256, 1);
  g.fillStyle = '#ffb224';
  g.fillRect(104, 0, 48, 256);
  g.fillStyle = '#fbfbfb';
  g.fillRect(22, 150, 70, 84);
  g.fillStyle = '#15181a';
  let x = 28;
  let s = label.length * 97 + 13;
  while (x < 86) {
    s = (s * 16807) % 2147483647;
    const w = 1 + (s % 3);
    g.fillRect(x, 158, w, 42);
    x += w + 1 + ((s >> 3) % 2);
  }
  g.font = '600 12px monospace';
  g.fillText(label, 28, 222);
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, 253, 253);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function mountAuthScene(canvas: HTMLCanvasElement, opts: { reduceMotion: boolean; theme: () => 'dark' | 'light' }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x2a2622, 0.8);
  const key = new THREE.DirectionalLight(0xffffff, 2.3);
  key.position.set(-5, 9, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 1, far: 30 });
  key.shadow.bias = -0.0005;
  scene.add(hemi, key);

  const floorMat = new THREE.ShadowMaterial({ opacity: 0.28 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // pallet
  const palletMat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.1 });
  const pallet = new THREE.Group();
  for (const z of [-0.95, 0, 0.95]) {
    const runner = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.14, 0.22), palletMat);
    runner.position.set(0, 0.07, z);
    runner.castShadow = runner.receiveShadow = true;
    pallet.add(runner);
  }
  for (let i = 0; i < 7; i++) {
    const slat = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 2.2), palletMat);
    slat.position.set(-1.3 + i * 0.433, 0.165, 0);
    slat.castShadow = slat.receiveShadow = true;
    pallet.add(slat);
  }
  scene.add(pallet);

  // crates: 3 x 3 base, 2 x 2 second layer, 1 on top = 14
  const size = 0.88;
  const slots: THREE.Vector3[] = [];
  for (const [n, y] of [
    [3, 0],
    [2, 1],
    [1, 2],
  ] as const) {
    const off = ((n - 1) * size) / 2;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) slots.push(new THREE.Vector3(i * size - off, 0.19 + size / 2 + y * size, j * size - off));
  }
  const labels = ['STL-10', 'DESK001', 'CHR004', 'BLT220', 'PLY018', 'TBL001', 'CAB210', 'HNG045', 'BOX060', 'GLU007', 'PNT031', 'WRP002', 'STL-10', 'DESK001'];
  const geo = new THREE.BoxGeometry(size * 0.96, size * 0.96, size * 0.96);
  const edgesGeo = new THREE.EdgesGeometry(geo);
  const edgeMat = new THREE.LineBasicMaterial({ transparent: true });
  const crateMats: THREE.MeshStandardMaterial[] = [];
  const crates = slots.map((slot, i) => {
    const mat = new THREE.MeshStandardMaterial({ map: crateTexture(labels[i]!), roughness: 0.75 });
    crateMats.push(mat);
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    g.add(mesh, new THREE.LineSegments(edgesGeo, edgeMat));
    g.position.copy(slot);
    scene.add(g);
    return { g, slot, delay: i * 0.16, spin: (i % 2 ? 1 : -1) * (0.4 + (i % 3) * 0.2) };
  });

  function applyTheme() {
    const p = PAL[opts.theme()];
    palletMat.color.setHex(p.pallet);
    crateMats.forEach((m) => m.color.setHex(p.crate));
    edgeMat.color.setHex(p.edge);
    edgeMat.opacity = p.edgeOpacity;
    hemi.intensity = p.hemi;
    key.intensity = p.key;
    floorMat.opacity = opts.theme() === 'dark' ? 0.45 : 0.2;
  }
  applyTheme();

  let w = 1;
  let h = 1;
  const resize = () => {
    w = canvas.clientWidth || 1;
    h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  const onMove = (e: PointerEvent) => {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
  };
  window.addEventListener('pointermove', onMove, { passive: true });

  const ease = (t: number) => 1 - Math.pow(1 - t, 3);
  let raf = 0;
  let t0 = performance.now();
  let visible = true;

  const frame = (now: number) => {
    const t = (now - t0) / 1000;
    const reduce = opts.reduceMotion;
    crates.forEach((c, i) => {
      if (reduce) {
        c.g.position.copy(c.slot);
        c.g.rotation.set(0, 0, 0);
        return;
      }
      const k = Math.min(1, Math.max(0, (t - c.delay) / 0.75));
      const e = ease(k);
      c.g.position.set(c.slot.x, c.slot.y + (1 - e) * 5, c.slot.z);
      c.g.rotation.y = (1 - e) * c.spin;
      // the last crate floats above the stack once everything has landed
      if (i === crates.length - 1 && t > c.delay + 0.9) {
        const f = Math.min(1, (t - c.delay - 0.9) / 1.2);
        c.g.position.y += ease(f) * 0.9 + Math.sin(t * 1.6) * 0.08 * f;
        c.g.rotation.y = Math.sin(t * 0.7) * 0.35 * f;
        c.g.rotation.x = Math.sin(t * 0.9) * 0.06 * f;
      }
    });
    const orbit = reduce ? 0.6 : 0.6 + Math.sin(t * 0.12) * 0.25;
    pointer.sx += (pointer.x - pointer.sx) * 0.05;
    pointer.sy += (pointer.y - pointer.sy) * 0.05;
    const r = 9.2;
    camera.position.set(Math.sin(orbit) * r + pointer.sx * 0.8, 5.6 - pointer.sy * 0.5, Math.cos(orbit) * r);
    camera.lookAt(0, 1.25, 0);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  };
  const start = () => {
    if (!raf && visible && !document.hidden) raf = requestAnimationFrame(frame);
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };
  const io = new IntersectionObserver(([e]) => {
    visible = !!e?.isIntersecting;
    if (visible) start();
    else stop();
  });
  io.observe(canvas);
  const onVis = () => (document.hidden ? stop() : start());
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('ss:theme', applyTheme);
  start();

  return {
    replay() {
      t0 = performance.now();
    },
    dispose() {
      stop();
      io.disconnect();
      ro.disconnect();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('ss:theme', applyTheme);
      document.removeEventListener('visibilitychange', onVis);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose?.();
      });
      crateMats.forEach((m) => m.map?.dispose());
      renderer.dispose();
    },
  };
}
