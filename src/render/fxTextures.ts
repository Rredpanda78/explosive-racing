import * as THREE from 'three';

/** 特效共用的小貼圖（用 canvas 畫，第一次用到才建立） */

function tex(size: number, draw: (c: CanvasRenderingContext2D, s: number) => void, srgb = true): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  draw(cv.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(cv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let glow: THREE.CanvasTexture | null = null;
/** 柔和的圓形光暈（白色，用材質顏色染色） */
export function glowTexture(): THREE.CanvasTexture {
  return (glow ??= tex(64, (c, s) => {
    const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, s, s);
  }));
}

let hole: THREE.CanvasTexture | null = null;
/** 彈孔：黑色破洞、外圈被打亮的金屬、幾道裂痕 */
export function holeTexture(): THREE.CanvasTexture {
  return (hole ??= tex(64, (c, s) => {
    const m = s / 2;
    const ring = c.createRadialGradient(m, m, s * 0.1, m, m, s * 0.42);
    ring.addColorStop(0, 'rgba(225,228,235,0.95)');
    ring.addColorStop(0.45, 'rgba(150,152,160,0.7)');
    ring.addColorStop(1, 'rgba(40,36,34,0)');
    c.fillStyle = ring;
    c.fillRect(0, 0, s, s);
    // 焦黑的放射狀刮痕
    c.strokeStyle = 'rgba(20,18,16,0.75)';
    c.lineWidth = 2;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + Math.random() * 0.5;
      c.beginPath();
      c.moveTo(m + Math.cos(a) * s * 0.1, m + Math.sin(a) * s * 0.1);
      c.lineTo(m + Math.cos(a) * s * (0.28 + Math.random() * 0.14), m + Math.sin(a) * s * (0.28 + Math.random() * 0.14));
      c.stroke();
    }
    // 中間的洞
    const g = c.createRadialGradient(m, m, 0, m, m, s * 0.17);
    g.addColorStop(0, 'rgba(5,5,6,1)');
    g.addColorStop(0.75, 'rgba(12,11,12,1)');
    g.addColorStop(1, 'rgba(30,28,28,0)');
    c.fillStyle = g;
    c.beginPath();
    c.arc(m, m, s * 0.17, 0, Math.PI * 2);
    c.fill();
  }));
}

let scorch: THREE.CanvasTexture | null = null;
/** 燒焦痕：不規則的黑色焦斑 */
export function scorchTexture(): THREE.CanvasTexture {
  return (scorch ??= tex(64, (c, s) => {
    const m = s / 2;
    for (let i = 0; i < 9; i++) {
      const x = m + (Math.random() - 0.5) * s * 0.35, y = m + (Math.random() - 0.5) * s * 0.35;
      const r = s * (0.14 + Math.random() * 0.16);
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(14,10,8,0.55)');
      g.addColorStop(1, 'rgba(30,20,12,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, s, s);
    }
    const g = c.createRadialGradient(m, m, 0, m, m, s * 0.5);
    g.addColorStop(0, 'rgba(8,6,5,0.75)');
    g.addColorStop(0.5, 'rgba(20,14,10,0.35)');
    g.addColorStop(1, 'rgba(20,14,10,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, s, s);
  }));
}

let star: THREE.CanvasTexture | null = null;
/** 槍口火光：四角星形的亮光 */
export function flashTexture(): THREE.CanvasTexture {
  return (star ??= tex(64, (c, s) => {
    const m = s / 2;
    const g = c.createRadialGradient(m, m, 0, m, m, m);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, s, s);
    c.fillStyle = 'rgba(255,255,255,0.9)';
    for (let i = 0; i < 4; i++) {
      c.save();
      c.translate(m, m);
      c.rotate((i * Math.PI) / 2 + 0.3);
      c.beginPath();
      c.moveTo(0, -3);
      c.lineTo(m * 0.95, 0);
      c.lineTo(0, 3);
      c.closePath();
      c.fill();
      c.restore();
    }
  }));
}
