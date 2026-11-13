import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/**
 * N2O 速度感後製（只有開泛光的畫質才有，接在泛光後面、輸出前面）：
 * - 往畫面中心（消失點）的放射狀模糊，只作用在畫面邊緣
 * - 邊緣的輕微色散（紅藍分開）
 * - 玩家排氣管後方一小塊熱浪扭曲
 * 沒有在噴的時候整個 pass 關掉，不花任何成本。
 */
const SpeedShader = {
  name: 'SpeedShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uBoost: { value: 0 },
    uCenter: { value: new THREE.Vector2(0.5, 0.56) },
    uAspect: { value: 1 },
    uHazePos: { value: new THREE.Vector2(0.5, 0.35) },
    uHaze: { value: 0 },
    uHazeR: { value: 0.1 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uBoost;
    uniform vec2 uCenter;
    uniform float uAspect;
    uniform vec2 uHazePos;
    uniform float uHaze;
    uniform float uHazeR;
    uniform float uTime;
    varying vec2 vUv;
    void main() {
      vec2 uv = vUv;
      // 熱浪：排氣管附近的畫面像隔著熱空氣一樣抖動（橢圓範圍，越靠中心越強）
      if (uHaze > 0.001) {
        vec2 d = uv - uHazePos;
        d.x *= uAspect * 0.55;
        float m = uHaze * (1.0 - smoothstep(uHazeR * 0.15, uHazeR, length(d)));
        uv += m * vec2(
          sin(uv.y * 160.0 + uTime * 31.0) + 0.6 * sin(uv.x * 90.0 - uTime * 17.0),
          cos(uv.x * 140.0 - uTime * 27.0) + 0.5 * sin(uv.y * 70.0 + uTime * 13.0)
        ) * 0.0032;
      }
      if (uBoost < 0.001) {
        gl_FragColor = texture2D(tDiffuse, uv);
        return;
      }
      vec2 dir = uv - uCenter;
      float dist = length(vec2(dir.x * uAspect, dir.y));
      // 只模糊邊緣：中央（車子與前方的路）保持清楚
      float edge = smoothstep(0.22, 0.9, dist) * uBoost;
      vec2 step = dir * (0.08 * edge / 6.0);
      // 每個像素的取樣起點錯開一點（抖動），把一格一格的殘影變成平順的拖影
      float jit = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 7; i++) {
        acc += texture2D(tDiffuse, uv - step * (float(i) + jit)).rgb;
      }
      acc /= 7.0;
      // 色散：紅色往外、藍色往內偏一點點
      vec2 ca = dir * 0.012 * edge;
      float r = texture2D(tDiffuse, uv + ca).r;
      float b = texture2D(tDiffuse, uv - ca).b;
      acc.r = mix(acc.r, r, 0.55 * edge);
      acc.b = mix(acc.b, b, 0.55 * edge);
      // 邊緣微微偏冷、壓暗，視線往中間集中
      acc *= 1.0 - 0.16 * edge * smoothstep(0.45, 1.1, dist);
      acc.b += 0.02 * edge;
      gl_FragColor = vec4(acc, 1.0);
    }`,
};

export class SpeedPass extends ShaderPass {
  constructor() {
    super(SpeedShader);
    this.enabled = false;
  }

  /** boost 0~1（速度感強度）、haze 0~1（熱浪強度）、熱浪中心的畫面座標（0~1，左下為原點）與半徑（以畫面高為 1） */
  set(boost: number, haze: number, hx: number, hy: number, hr: number, aspect: number, time: number): void {
    const u = this.uniforms as typeof SpeedShader.uniforms;
    u.uBoost.value = boost;
    u.uHaze.value = haze;
    u.uHazePos.value.set(hx, hy);
    u.uHazeR.value = hr;
    u.uAspect.value = aspect;
    u.uTime.value = time % 1000;
    this.enabled = boost > 0.01 || haze > 0.01;
  }
}
