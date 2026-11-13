import * as THREE from 'three';
import type { Theme } from './themes';

/**
 * 每張地圖自己的環境光貼圖（給車漆反射與整個場景的環境光用）：
 * 依主題的天空色畫一顆天空球——上方天色、地平線、遠山剪影、地面、太陽（月亮），
 * 夜城再加上大樓窗戶與霓虹招牌——然後用 PMREM 預先模糊成各種粗糙度的反射。
 * 只在換地圖時算一次，平常每幀沒有額外成本。
 */
export function skyEnvironment(pmrem: THREE.PMREMGenerator, th: Theme): THREE.WebGLRenderTarget {
  const scene = new THREE.Scene();
  const night = th.night;
  // 地面：正下方是路面（車子大多在路上），往地平線過去才是草地、沙地
  const ground = new THREE.Color(th.ground[0]).multiplyScalar(night ? 0.5 : 0.55);
  const road = new THREE.Color(th.road).multiplyScalar(0.6);
  const neon = new Array(5).fill(0).map((_, i) => new THREE.Color(th.accents[i % th.accents.length]));
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(th.skyTop) },
      horizon: { value: new THREE.Color(th.skyHorizon) },
      ground: { value: ground },
      road: { value: road },
      mountain: { value: new THREE.Color(th.mountain).lerp(new THREE.Color(th.skyHorizon), night ? 0.15 : 0.35) },
      sunDir: { value: new THREE.Vector3(...th.sunDir).normalize() },
      sunCol: { value: night ? new THREE.Color(0.7, 0.8, 1.0) : new THREE.Color(th.sunColor) },
      disc: { value: th.sunDisc },
      cloud: { value: th.cloud === null ? 0 : 1 },
      night: { value: night ? 1 : 0 },
      mesa: { value: th.vegetation === 'desert' ? 1 : 0 },
      neon: { value: neon },
      glow: { value: new THREE.Vector3(...(th.horizonGlow ?? [0.16, 0.05, 0.2])) },
    },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform vec3 top, horizon, ground, road, mountain, sunDir, sunCol;
      uniform float disc, cloud, night, mesa;
      uniform vec3 neon[5];
      uniform vec3 glow;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
      void main() {
        vec3 d = normalize(vDir);
        float y = d.y;
        float az = atan(d.z, d.x);
        // 天空：地平線到天頂的漸層
        vec3 c = mix(horizon, top, pow(clamp(y, 0.0, 1.0), 0.5));
        // 白天的雲：一團團亮白
        if (cloud > 0.5 && y > 0.02) {
          vec2 cp = d.xz / (y + 0.25) * 1.6;
          float cl = smoothstep(0.52, 0.8, fbm(cp + 3.0)) * smoothstep(0.02, 0.18, y);
          c = mix(c, horizon * 1.15 + 0.1, cl * 0.75);
        }
        // 地面：從地平線的霧色漸漸變成地面顏色
        if (y < 0.0) {
          c = mix(horizon * 0.55 + ground * 0.45, ground, smoothstep(0.0, 0.3, -y));
          c = mix(c, road, smoothstep(0.3, 0.75, -y));
        }
        // 遠山剪影（沙漠是平頂岩台）
        float ridge = mesa > 0.5
          ? 0.035 + 0.06 * step(0.45, noise(vec2(az * 4.0, 1.0))) * (0.7 + 0.3 * noise(vec2(az * 30.0, 2.0)))
          : 0.02 + 0.09 * pow(fbm(vec2(az * 2.2, 0.5)), 1.6);
        float mtn = (1.0 - smoothstep(ridge - 0.004, ridge + 0.004, y)) * smoothstep(-0.03, 0.0, y);
        c = mix(c, mountain, mtn * (night > 0.5 ? 0.9 : 0.7));
        // 夜城：一圈大樓剪影、亮著的窗戶與霓虹招牌，讓車漆映出城市的燈光
        if (night > 0.5) {
          float bh = 0.06 + 0.22 * pow(noise(vec2(floor(az * 26.0), 7.0)), 1.4);
          float inB = (1.0 - step(bh, y)) * step(-0.02, y);
          c = mix(c, vec3(0.012, 0.014, 0.03), inB);
          vec2 w = vec2(az * 160.0, y * 90.0);
          float lit = step(0.62, hash(floor(w))) * step(0.25, fract(w.x)) * step(0.3, fract(w.y));
          vec3 wc = mix(vec3(1.0, 0.72, 0.38), vec3(0.45, 0.85, 1.0), step(0.75, hash(floor(w) + 3.1)));
          c += wc * lit * inB * 0.9;
          // 招牌：沿著地平線散布的彩色發光方塊
          for (int i = 0; i < 14; i++) {
            float fi = float(i);
            float a0 = fi * 0.4488 + hash(vec2(fi, 1.0)) * 0.3 - 3.14159;
            float e0 = 0.04 + hash(vec2(fi, 2.0)) * 0.16;
            float wa = 0.05 + hash(vec2(fi, 3.0)) * 0.08, he = 0.015 + hash(vec2(fi, 4.0)) * 0.04;
            float da = abs(mod(az - a0 + 3.14159, 6.28318) - 3.14159);
            float sgn = (1.0 - smoothstep(wa * 0.8, wa, da)) * (1.0 - smoothstep(he * 0.8, he, abs(y - e0)));
            c += neon[i - (i / 5) * 5] * sgn * 5.0;
          }
          // 城市光害：地平線附近的光暈（夜城偏紫紅、夜市小鎮偏橘）
          c += glow * exp(-abs(y) * 14.0);
        }
        // 太陽（月亮）本體與光暈：本體很亮，模糊後在車漆上變成一塊柔和的亮斑
        float s = max(dot(d, sunDir), 0.0);
        c += sunCol * disc * (pow(s, 1800.0) * 70.0 + pow(s, 90.0) * 1.4 + pow(s, 10.0) * 0.25);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), mat);
  scene.add(sky);
  const rt = pmrem.fromScene(scene, 0, 0.1, 100);
  sky.geometry.dispose();
  mat.dispose();
  return rt;
}
