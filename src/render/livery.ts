import * as THREE from 'three';

/**
 * 車體花色：在貼圖上做兩件事——
 * 1. 有顏色的地方（塗裝、拉花）旋轉色相
 * 2. 亮的無彩色區域（白色、銀色車身）染成指定顏色
 * 黑色、輪胎、玻璃這些暗或灰的地方不受影響。
 */
export interface Livery {
  name: string;
  /** 色相旋轉角度（度） */
  hue: number;
  /** 白色／銀色車身要染的顏色；null = 不染 */
  tint: number | null;
}

/**
 * 把基本材質換成有光澤、會反射環境的車漆材質，並套上花色（hue = 0、tint = null 時就是原廠色）。
 * gloss = true（精緻畫質）時多一層清漆：表面一層很亮很銳利的反射，映出天空、夕陽與霓虹。
 */
export function liveryMaterial(base: THREE.Material, lv: Livery | undefined, gloss = false): THREE.MeshStandardMaterial {
  const b = base as THREE.MeshLambertMaterial;
  const opt = { map: b.map, color: b.color?.clone() ?? new THREE.Color(0xffffff), roughness: 0.5, metalness: 0.1, envMapIntensity: 1 };
  const m = gloss
    ? new THREE.MeshPhysicalMaterial({ ...opt, roughness: 0.42, clearcoat: 1, clearcoatRoughness: 0.07 })
    : new THREE.MeshStandardMaterial(opt);
  if (!lv || (lv.hue === 0 && lv.tint === null)) return m;
  const uHue = { value: (lv.hue * Math.PI) / 180 };
  const uTint = { value: new THREE.Color(lv.tint ?? 0xffffff) };
  const uTintAmt = { value: lv.tint === null ? 0 : 1 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uHue = uHue;
    sh.uniforms.uTint = uTint;
    sh.uniforms.uTintAmt = uTintAmt;
    sh.fragmentShader = 'uniform float uHue;\nuniform vec3 uTint;\nuniform float uTintAmt;\n' + sh.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      {
        vec3 c = diffuseColor.rgb;
        float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
        float sat = (mx - mn) / (mx + 1e-4);
        const vec3 k = vec3(0.57735);
        float ch = cos(uHue), sh2 = sin(uHue);
        vec3 rot = c * ch + cross(k, c) * sh2 + k * dot(k, c) * (1.0 - ch);
        c = mix(c, max(rot, 0.0), smoothstep(0.12, 0.3, sat));
        float l = dot(c, vec3(0.299, 0.587, 0.114));
        float neutral = (1.0 - smoothstep(0.08, 0.25, sat)) * smoothstep(0.18, 0.5, mx);
        c = mix(c, uTint * l * 1.3, neutral * uTintAmt);
        diffuseColor.rgb = c;
      }`,
    );
  };
  m.customProgramCacheKey = () => 'livery';
  return m;
}

/** 選單上的色票顏色 */
export function liverySwatch(lv: Livery, baseHex: number): string {
  const c = new THREE.Color(lv.tint ?? baseHex);
  if (lv.tint === null && lv.hue) c.offsetHSL(lv.hue / 360, 0, 0);
  return '#' + c.getHexString();
}
