import type * as THREE from 'three';
import { onLang } from '../i18n';

// 場景裡跟著語言的字（捷徑指示牌、落石警告牌、海底隧道入口的名牌）：
// 畫在 CanvasTexture 上的字換語言時整張重畫，不用重建場景。
// 台灣賽道的店招、廟宇、路面標字是場景的一部分，兩種語言都維持中文，不走這裡。

const live = new Set<{ tex: THREE.CanvasTexture; draw: (c: CanvasRenderingContext2D) => void }>();

onLang(() => {
  for (const s of live) {
    const cv = s.tex.image as HTMLCanvasElement;
    const c = cv.getContext('2d');
    if (!c) continue;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);
    s.draw(c);
    s.tex.needsUpdate = true;
  }
});

/** 這張貼圖的內容跟著語言：draw 要畫整張（換語言時會先清空再呼叫一次）。貼圖 dispose 後自動取消 */
export function liveSign(tex: THREE.CanvasTexture, draw: (c: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const s = { tex, draw };
  live.add(s);
  tex.addEventListener('dispose', () => live.delete(s));
  return tex;
}

/** 單行字縮到放得進 maxW 寬：從 size 往下縮（最小 minSize） */
export function fitFont(c: CanvasRenderingContext2D, text: string, size: number, maxW: number, family: string, minSize = 10): void {
  let s = size;
  c.font = `bold ${s}px ${family}`;
  while (s > minSize && c.measureText(text).width > maxW) {
    s -= 1;
    c.font = `bold ${s}px ${family}`;
  }
}
