import * as THREE from 'three';
import { PRIMARY_IDS, SECONDARY_IDS, type WeaponId } from '../game/weapons';
import { buildPrimary, buildSecondary } from './weaponModels';

/** 車庫卡片上的武器圖：第一次需要時用一個小的離屏渲染器把每把武器拍成圖片 */
let icons: Partial<Record<WeaponId, string>> | null = null;

export function weaponIcon(id: WeaponId): string | undefined {
  if (!icons) icons = renderIcons();
  return icons[id];
}

function renderIcons(): Partial<Record<WeaponId, string>> {
  const out: Partial<Record<WeaponId, string>> = {};
  const W = 320, H = 150;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    return out;
  }
  renderer.setSize(W, H, false);
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2420, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(2, 3, 2.5);
  const rim = new THREE.DirectionalLight(0x9fc4ff, 1.4);
  rim.position.set(-3, 1.5, -2);
  scene.add(key, rim);
  const cam = new THREE.PerspectiveCamera(28, W / H, 0.05, 50);
  const box = new THREE.Box3();
  const size = new THREE.Vector3(), center = new THREE.Vector3();

  const shoot = (id: WeaponId, g: THREE.Object3D) => {
    // 側前方 3/4 視角，依模型大小自動對焦
    g.rotation.y = -0.62;
    scene.add(g);
    g.updateMatrixWorld(true);
    box.setFromObject(g);
    box.getSize(size);
    box.getCenter(center);
    const r = Math.max(size.x * 0.75, size.y * 1.9, size.z * 0.75) * 0.62;
    const dist = (r / Math.tan((cam.fov * Math.PI) / 360)) * 0.74;
    cam.position.set(center.x + dist * 0.55, center.y + dist * 0.32, center.z + dist * 0.78);
    cam.lookAt(center);
    renderer.render(scene, cam);
    out[id] = renderer.domElement.toDataURL('image/png');
    scene.remove(g);
    g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
  };
  for (const id of PRIMARY_IDS) shoot(id, buildPrimary(id, 1).group);
  for (const id of SECONDARY_IDS) shoot(id, buildSecondary(id));
  renderer.dispose();
  renderer.forceContextLoss();
  return out;
}
