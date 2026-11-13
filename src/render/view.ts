import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { Kart } from '../game/kart';
import type { Race, RaceEvent } from '../game/race';
import type { Track } from '../game/track';
import { clamp, lerpAngle } from '../game/util';
import { CARS } from '../game/cars';
import { PRIMARY, shieldHalfArc } from '../game/weapons';
import { Shards } from './shards';
import { HazardView } from './hazards';
import { BlastFx, Debris, Scorch, SkidMarks, Trails } from './effects';
import { clusterMineMaterial, hexMineGeometry, steelMaterial } from './weaponModels';
import { KartView } from './kartModel';
import { Particles } from './particles';
import { skyEnvironment } from './sky';
import { THEMES, type Theme } from './themes';
import { Weather, type WeatherKind } from './weather';
import { buildWorld, type World } from './world';
import type { Quality } from '../settings';

/** 每張地圖的天氣 */
const WEATHER: Record<string, WeatherKind> = { meadow: 'petals', desert: 'sand', city: 'rain' };

const MAX_TRACERS = 320;
const POOL = 16;
const MAX_MINES = 64;
const MAX_CLUSTER = 80;
/** 天空環境光的強度（影響整個場景的環境光與車漆反射） */
const ENV_DAY = 1.0;
const ENV_NIGHT = 2.8;

export class GameView {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(66, 1, 0.3, 4000);
  mobile: boolean;
  /** 景物、粒子減量（低畫質或手機中畫質） */
  lowDetail: boolean;
  /** 畫面震動倍率（設定） */
  shakeMul = 1;
  shadows: boolean;
  /** 畫面震動強度 0~1（實際位移為平方） */
  shake = 0;
  /** 0~1，氮氣／加速帶時的速度感，HUD 用來畫速度線 */
  boostK = 0;
  /** 精緻畫質（高畫質，或電腦的中畫質）：車漆清漆、車燈光暈、路面與地形細節、草叢 */
  rich: boolean;
  quality: Quality;
  /** 動態解析度：目前的像素比，會依幀耗時在 resMin～resMax 之間調整（除錯：__game.view.resScale） */
  resScale = 1;
  resMin = 1;
  resMax = 1;
  /** 設成 false 暫停動態解析度（除錯、截圖用） */
  dynRes = true;

  private composer: EffectComposer | null = null;
  /** 環境光貼圖（每張地圖的天空）與產生它的工具 */
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  /** 動態解析度的量測：1 秒一個區間，連續幾個區間太慢就降、夠快就升 */
  private frameLast = 0;
  private frameSum = 0;
  private frameN = 0;
  private winStart = 0;
  private slowWins = 0;
  private fastWins = 0;
  private resChangedAt = 0;
  private resUpAt = -1e9;
  private resUpBlock = 0;
  private resBackoff = 20000;
  private resHold = 0;
  private world?: World;
  private track?: Track;
  private kartViews = new Map<Kart, KartView>();
  private smoke = new Particles(1100, false);
  private fire = new Particles(1800, true);
  private skid = new SkidMarks();
  private trails = new Trails(16);
  /** 甩尾時輪胎後方貼著地面的亮白拖痕（跑跑那種一道道白光） */
  private streaks = new Trails(16, 46, 0.3);
  private scorch = new Scorch(40);
  private debris: Debris | null = null;
  /** 護盾碎片 */
  private shards = new Shards();
  private blast = new BlastFx();
  private tracers: THREE.InstancedMesh;
  private missiles: THREE.Group[] = [];
  private shells: THREE.Mesh[] = [];
  private barrels: THREE.Mesh[] = [];
  private barrelGeo: THREE.BufferGeometry;
  private barrelMat: THREE.MeshLambertMaterial;
  private barrelHot: THREE.MeshBasicMaterial;
  private hazardView: HazardView | null = null;
  private weather: Weather | null = null;
  private groundHint = 0;
  private driftRoll = 0;
  /** 地雷與集束圓雷：本體與閃燈（閃燈用每個實例的顏色控制亮暗） */
  private mineBody: THREE.InstancedMesh;
  private mineLight: THREE.InstancedMesh;
  private clusterBody: THREE.InstancedMesh;
  private clusterLight: THREE.InstancedMesh;
  private col = new THREE.Color();
  private sun: THREE.DirectionalLight;
  /** 從太陽的反方向打過來的背光：讓車與景物的輪廓從背景跳出來 */
  private rim: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private sunDir = new THREE.Vector3(0.6, 0.5, 0.4).normalize();
  /** 夜間地圖才會亮的車頭燈 */
  private headlight: THREE.SpotLight;
  private bloomPass: UnrealBloomPass | null = null;
  private theme: Theme = THEMES.meadow;
  private camYaw = 0;
  private camY = 0;
  private fov = 66;
  private time = 0;
  private shakeT = 0;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v3 = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);

  constructor(canvas: HTMLCanvasElement, mobile: boolean, quality: Quality = mobile ? 'medium' : 'high') {
    this.mobile = mobile;
    // 畫質：低 = 不開陰影與泛光、景物減量；中 = 電腦開陰影與泛光、手機不開；高 = 全開
    this.quality = quality;
    this.lowDetail = quality === 'low' || (mobile && quality !== 'high');
    this.shadows = quality === 'high' || (quality === 'medium' && !mobile);
    this.rich = this.shadows;
    const post = quality === 'high' || (quality === 'medium' && !mobile);
    // 反鋸齒：有後製時由後製的多重取樣畫框負責；沒有後製（低畫質、手機中畫質）時由畫布本身負責
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !post, powerPreference: 'high-performance' }));
    // 動態解析度的範圍（不超過螢幕本身的像素比），一開始用最高
    const dpr = window.devicePixelRatio || 1;
    const [lo, hi] = quality === 'low' ? [0.6, 1] : quality === 'medium' ? [0.75, 1.5] : [1, 2];
    this.resMax = Math.min(hi, dpr);
    this.resMin = Math.min(lo, this.resMax);
    this.resScale = this.resMax;
    r.setPixelRatio(this.resScale);
    // iPhone 記憶體不夠時會把 3D 畫面收回（常在轉向、切換 App 時）：等它還回來，5 秒還沒回來就重新載入，不要卡在最後一格
    let lostTimer = 0;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      lostTimer = window.setTimeout(() => location.reload(), 5000);
    });
    canvas.addEventListener('webglcontextrestored', () => {
      window.clearTimeout(lostTimer);
      this.resize();
    });
    // 色調映射：讓太陽、火焰這些很亮的地方平順地壓回螢幕能顯示的範圍，又不會讓顏色變灰
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1.08;

    // 顏色與強度在 setTrack() 依地圖主題設定
    this.scene.background = new THREE.Color(0);
    this.scene.fog = new THREE.Fog(0, 280, 1500);
    // 天空光偏藍、地面反光偏綠；太陽是暖色，照不到的地方自然偏冷，畫面才有立體感
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1);
    const sun = (this.sun = new THREE.DirectionalLight(0xffffff, 2));
    this.headlight = new THREE.SpotLight(0xfff0d0, 0, 95, 0.52, 0.65, 1.3);
    this.rim = new THREE.DirectionalLight(0xa9c8ff, 0.7);
    this.scene.add(this.hemi, sun, sun.target, this.rim, this.rim.target, this.headlight, this.headlight.target);
    // 環境光與反射：在 setTrack() 依地圖的天空產生
    this.pmrem = new THREE.PMREMGenerator(r);
    if (this.shadows) {
      r.shadowMap.enabled = true;
      r.shadowMap.type = THREE.PCFShadowMap;
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      const c = sun.shadow.camera;
      // 陰影範圍往鏡頭前方挪（updateSun），範圍可以縮小一點，近處的陰影比較清楚
      c.left = -76; c.right = 76; c.top = 76; c.bottom = -76; c.near = 10; c.far = 520;
      sun.shadow.bias = -0.0006;
      sun.shadow.normalBias = 0.07;
    }

    // 後製：泛光讓火焰、噴射、太陽、加速帶發亮
    if (quality === 'high' || (quality === 'medium' && !mobile)) {
      const size = r.getDrawingBufferSize(new THREE.Vector2());
      const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
      this.composer = new EffectComposer(r, rt);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.3, 0.6, 1.25);
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(new OutputPass());
    }

    this.scene.add(this.skid.mesh, this.blast.group, this.smoke.points, this.fire.points, this.trails.mesh, this.streaks.mesh, this.scorch.mesh);

    this.tracers = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.1, 0.1, 5.5),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.7, 0.8), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
      MAX_TRACERS,
    );
    this.tracers.count = 0;
    this.tracers.frustumCulled = false;
    this.scene.add(this.tracers);

    const mBody = new THREE.CylinderGeometry(0.15, 0.15, 1.2, 8).rotateX(Math.PI / 2);
    const mNose = new THREE.ConeGeometry(0.15, 0.4, 8).rotateX(Math.PI / 2).translate(0, 0, 0.8);
    const mFin = new THREE.BoxGeometry(0.7, 0.04, 0.3).translate(0, 0, -0.5);
    const mWhite = new THREE.MeshLambertMaterial({ color: 0xf2f2f2 });
    const mRed = new THREE.MeshLambertMaterial({ color: 0xff4433 });
    const shellGeo = new THREE.SphereGeometry(0.34, 10, 8);
    const shellMat = new THREE.MeshLambertMaterial({ color: 0x2a2d33 });
    for (let i = 0; i < POOL; i++) {
      const g = new THREE.Group();
      const fin2 = new THREE.Mesh(mFin, mRed);
      fin2.rotation.z = Math.PI / 2;
      g.add(new THREE.Mesh(mBody, mWhite), new THREE.Mesh(mNose, mRed), new THREE.Mesh(mFin, mRed), fin2);
      g.visible = false;
      this.scene.add(g);
      this.missiles.push(g);
      const s = new THREE.Mesh(shellGeo, shellMat);
      s.visible = false;
      this.scene.add(s);
      this.shells.push(s);
    }

    // 爆炸桶：紅色油桶加黃色警示帶
    const cv = document.createElement('canvas');
    cv.width = 128;
    cv.height = 64;
    const c2 = cv.getContext('2d')!;
    c2.fillStyle = '#d7263d';
    c2.fillRect(0, 0, 128, 64);
    c2.fillStyle = '#8f1526';
    for (const y of [8, 52]) c2.fillRect(0, y, 128, 4);
    c2.fillStyle = '#ffd23f';
    c2.fillRect(0, 22, 128, 20);
    c2.fillStyle = '#1a1a1a';
    for (let x = -20; x < 140; x += 20) {
      c2.beginPath();
      c2.moveTo(x, 42); c2.lineTo(x + 10, 42); c2.lineTo(x + 20, 22); c2.lineTo(x + 10, 22);
      c2.closePath();
      c2.fill();
    }
    const btex = new THREE.CanvasTexture(cv);
    btex.colorSpace = THREE.SRGBColorSpace;
    this.barrelGeo = new THREE.CylinderGeometry(0.78, 0.78, 1.6, 14).translate(0, 0.8, 0);
    this.barrelMat = new THREE.MeshLambertMaterial({ map: btex });
    this.barrelHot = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.4, 1.2) });

    const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number, colors: boolean) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.count = 0;
      m.frustumCulled = false;
      if (colors) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      this.scene.add(m);
      return m;
    };
    // 地雷：六角形外殼、中間的紅燈；集束圓雷：紅白條紋圓球、腰間一圈燈
    this.mineBody = inst(hexMineGeometry(), steelMaterial(), MAX_MINES, false);
    this.mineLight = inst(new THREE.CylinderGeometry(0.17, 0.2, 0.08, 10).translate(0, 0.22, 0), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_MINES, true);
    this.clusterBody = inst(new THREE.SphereGeometry(0.34, 14, 10).translate(0, 0.34, 0), clusterMineMaterial(), MAX_CLUSTER, false);
    this.clusterLight = inst(new THREE.TorusGeometry(0.345, 0.035, 6, 16).rotateX(Math.PI / 2).translate(0, 0.34, 0), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_CLUSTER, true);
    this.mineBody.castShadow = this.clusterBody.castShadow = this.shadows;
    this.resize();
  }

  /** 模型載入完成後呼叫，建立賽道場景與零件池 */
  setTrack(track: Track): void {
    if (this.world) {
      // 換地圖：移除舊場景並釋放它佔用的顯示記憶體
      this.scene.remove(this.world.group);
      this.world.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
        for (const mt of mats) mt.dispose();
      });
    }
    this.track = track;
    const th = (this.theme = THEMES[track.def.theme]);
    (this.scene.background as THREE.Color).setHex(th.skyHorizon);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.setHex(th.skyHorizon);
    fog.near = th.fogNear;
    fog.far = th.fogFar;
    this.hemi.color.setHex(th.hemiSky);
    this.hemi.groundColor.setHex(th.hemiGround);
    this.hemi.intensity = th.hemiIntensity;
    this.sun.color.setHex(th.sunColor);
    this.sun.intensity = th.sunIntensity;
    this.sunDir.set(th.sunDir[0], th.sunDir[1], th.sunDir[2]).normalize();
    this.renderer.toneMappingExposure = th.exposure;
    if (this.bloomPass) this.bloomPass.strength = th.bloom;
    this.headlight.intensity = th.night ? 110 : 0;
    // 環境光：這張地圖的天空（車漆會映出天色、夕陽、霓虹）
    const oldEnv = this.envRT;
    this.envRT = skyEnvironment(this.pmrem, th);
    this.scene.environment = this.envRT.texture;
    oldEnv?.dispose();
    this.scene.environmentIntensity = th.night ? ENV_NIGHT : ENV_DAY;
    this.rim.color.setHex(th.night ? 0x7f9cff : 0xcfe0ff);
    this.rim.intensity = th.night ? 0.9 : 0.55;
    // 地面細節：低畫質與手機中畫質不做；草叢只有電腦高畫質是密的
    this.world = buildWorld(track, th, this.shadows, this.lowDetail, this.lowDetail ? 0 : this.quality === 'high' && !this.mobile ? 2 : 1);
    this.scene.add(this.world.group);
    // 天氣：路面上用路面高度，路外用地形高度
    this.weather?.dispose();
    const world = this.world;
    this.weather = new Weather(WEATHER[th.id] ?? 'petals', {
      mobile: this.lowDetail,
      groundY: (x, z) => {
        this.groundHint = track.probe(x, z, this.groundHint < 0 ? -1 : this.groundHint);
        return track.probeOn ? track.probeY : world.terrainH(x, z);
      },
    });
    this.groundHint = -1;
    this.scene.add(this.weather.group);
    if (this.debris) this.scene.remove(this.debris.group);
    this.debris = new Debris(this.lowDetail ? 16 : 36, this.shadows);
    this.scene.add(this.debris.group);
    if (!this.shards.mesh.parent) this.scene.add(this.shards.mesh);
    this.resHold = performance.now() + 2500;
  }

  setRace(race: Race | null): void {
    for (const kv of this.kartViews.values()) {
      this.scene.remove(kv.group);
      kv.dispose();
    }
    this.kartViews.clear();
    for (const b of this.barrels) this.scene.remove(b);
    this.barrels = [];
    if (this.hazardView) {
      this.scene.remove(this.hazardView.group);
      this.hazardView.dispose();
      this.hazardView = null;
    }
    this.mineBody.count = this.mineLight.count = this.clusterBody.count = this.clusterLight.count = 0;
    this.smoke.clear();
    this.fire.clear();
    this.skid.clear();
    this.trails.clear();
    this.streaks.clear();
    this.scorch.clear();
    this.debris?.clear();
    this.shards.clear();
    this.blast.clear();
    this.tracers.count = 0;
    for (const m of this.missiles) m.visible = false;
    for (const s of this.shells) s.visible = false;
    this.shake = 0;
    this.boostK = 0;
    if (!race) return;
    for (const k of race.karts) {
      // 線上比賽：其他玩家（不含電腦車手）頭上顯示名字
      const label = race.online && !k.isPlayer && !k.bot ? k.name : undefined;
      const kv = new KartView({ color: k.color, primary: k.primary, secondary: k.secondary, secondaryLvl: k.secondaryLvl, isPlayer: k.isPlayer, model: CARS[k.car].model, fallback: k.car, livery: CARS[k.car].liveries[k.livery], label }, this.shadows, { rich: this.rich, lights: this.quality !== 'low', night: this.theme.night });
      this.kartViews.set(k, kv);
      this.scene.add(kv.group);
      kv.update(k, 0);
    }
    this.hazardView = new HazardView(race, race.track, this.theme, this.shadows);
    this.scene.add(this.hazardView.group);
    for (const b of race.barrels) {
      const m = new THREE.Mesh(this.barrelGeo, this.barrelMat);
      m.position.set(b.x, b.y, b.z);
      m.rotation.y = Math.random() * 6;
      m.castShadow = this.shadows;
      this.scene.add(m);
      this.barrels.push(m);
    }
    this.camYaw = race.player.heading;
    this.camY = race.player.y;
    // 開場會編譯一堆材質，前幾秒的幀耗時不準，先不調解析度
    this.resHold = performance.now() + 2500;
  }

  resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    // 視窗被縮到 0（例如分頁隱藏）時不要把畫布設成 0，否則後製的畫框會失效
    if (w < 2 || h < 2) return;
    this.renderer.setSize(w, h, false);
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.updateParticleScale();
  }

  private updateParticleScale(): void {
    const hpx = this.renderer.domElement.height;
    const s = hpx / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.smoke.setScale(s);
    this.fire.setScale(s);
  }

  /** 世界座標轉螢幕座標（CSS 像素）；在鏡頭後方時回傳 false */
  project(x: number, y: number, z: number, out: { x: number; y: number }): boolean {
    const v = this.v3.set(x, y, z).project(this.camera);
    if (v.z > 1 || v.z < -1) return false;
    out.x = (v.x * 0.5 + 0.5) * window.innerWidth;
    out.y = (-v.y * 0.5 + 0.5) * window.innerHeight;
    return true;
  }

  addShake(a: number): void {
    this.shake = Math.min(1, this.shake + a * this.shakeMul);
  }

  private sparks(x: number, y: number, z: number, n: number, speed: number, ground: number, vx = 0, vz = 0): void {
    const R = Math.random;
    for (let i = 0; i < n; i++) {
      this.fire.spawn(x, y, z, vx + (R() - 0.5) * speed, 1.5 + R() * speed * 0.5, vz + (R() - 0.5) * speed, 0.25 + R() * 0.3, 0.5, 0.08, 1, 0.8, 0.35, 1, 20, 0, ground);
    }
  }

  onEvent(e: RaceEvent, race: Race): void {
    const f = this.fire, sm = this.smoke;
    const R = Math.random;
    const p = race.player;
    switch (e.t) {
      case 'shot':
        this.kartViews.get(e.k)?.muzzleFlash(e.side);
        f.spawn(e.x, e.y, e.z, e.k.vx, 0, e.k.vz, 0.06, 2.2, 0.8, 1, 0.8, 0.35, 0.9);
        break;
      case 'rail':
        // 雷射射出：槍口一團亮光，自己開火時鏡頭小震一下
        f.spawn(e.x, e.y, e.z, e.k.vx, 0, e.k.vz, 0.1, 3.2, 0.55, 1, 0.45, 0.6, 1);
        if (e.k === p) this.addShake(0.12);
        break;
      case 'hit':
        if (e.w === 'flame') {
          if (e.k === p) this.addShake(0.03);
          break;
        }
        if (e.w === 'laser') {
          this.sparks(e.x, e.y, e.z, 10, 22, e.k.y, e.k.vx * 0.5, e.k.vz * 0.5);
          f.spawn(e.x, e.y, e.z, e.k.vx, 0, e.k.vz, 0.12, 4.5, 0.5, 1, 0.4, 0.5, 0.95);
          if (e.k === p) this.addShake(0.35);
          break;
        }
        this.sparks(e.x, e.y, e.z, 5, 18, e.k.y, e.k.vx * 0.5, e.k.vz * 0.5);
        f.spawn(e.x, e.y, e.z, 0, 0, 0, 0.07, 2.4, 0.6, 1, 0.9, 0.6, 0.9);
        // 偶爾打下一小塊碎片並冒一點煙
        if (R() < 0.12) this.debris?.burst(e.x, e.y, e.z, e.k.y, 1, 6);
        if (R() < 0.3) sm.spawn(e.x, e.y, e.z, e.k.vx * 0.5, 1, e.k.vz * 0.5, 0.5, 0.4, 1.6, 0.25, 0.25, 0.27, 0.4);
        if (e.k === p) this.addShake(0.1);
        break;
      case 'shatter': {
        // 護盾碎掉：整片裂成碎片往外噴，閃一下
        this.kartViews.get(e.k)?.shieldBreak();
        this.shards.burst(e.k.x, e.k.y, e.k.z, e.k.heading, shieldHalfArc(e.k.secondaryLvl), e.k.vx, e.k.vz, this.lowDetail ? 22 : 40);
        const bx = e.k.x - Math.sin(e.k.heading) * 2, bz = e.k.z - Math.cos(e.k.heading) * 2;
        f.spawn(bx, e.k.y + 1, bz, e.k.vx * 0.5, 0, e.k.vz * 0.5, 0.18, 5.5, 0.5, 0.85, 1, 1, 0.9);
        this.sparks(bx, e.k.y + 1, bz, 12, 16, e.k.y, e.k.vx * 0.5, e.k.vz * 0.5);
        if (e.k === p) this.addShake(0.25);
        break;
      }
      case 'block':
        // 護盾擋下：藍白色火花，護盾亮一下
        this.kartViews.get(e.k)?.shieldHit();
        f.spawn(e.x, e.y, e.z, e.k.vx * 0.6, 0, e.k.vz * 0.6, 0.08, 2.2, 0.45, 0.8, 1, 1, 0.9);
        if (R() < 0.6) this.sparks(e.x, e.y, e.z, 3, 10, e.k.y, e.k.vx * 0.6, e.k.vz * 0.6);
        break;
      case 'impact':
        if (R() < 0.5) this.sparks(e.x, e.y, e.z, 2, 8, e.y - 1);
        sm.spawn(e.x, e.y, e.z, 0, 0.6, 0, 0.35, 0.3, 1.2, 0.75, 0.72, 0.68, 0.35);
        break;
      case 'hazard':
        this.sparks(e.x, e.y, e.z, 14, 16, e.k.y);
        this.debris?.burst(e.x, e.y, e.z, e.k.y, 2, 9);
        if (e.k === p) this.addShake(0.75);
        break;
      case 'rock': {
        // 碎石與塵土
        this.debris?.burst(e.x, e.y, e.z, e.y - e.r, 6, 12);
        for (let i = 0; i < 18; i++) {
          const a = R() * Math.PI * 2, sp = 2 + R() * 6;
          sm.spawn(e.x, e.y, e.z, Math.cos(a) * sp, 1 + R() * 3, Math.sin(a) * sp, 1 + R(), 2, 6, 0.72, 0.6, 0.48, 0.6, -0.4, 1.2);
        }
        const d = Math.hypot(e.x - p.x, e.z - p.z);
        this.addShake(clamp(1 - d / 50, 0, 1) * 0.4);
        break;
      }
      case 'blast': {
        const big = e.kart ? 1.5 : 1;
        // 火球碎片
        const n = Math.round((18 + e.r * 2.2) * big);
        for (let i = 0; i < n; i++) {
          const a = R() * Math.PI * 2, sp = (0.3 + R()) * e.r * 1.7;
          f.spawn(e.x, e.y, e.z, Math.cos(a) * sp, 2 + R() * e.r * 1.6, Math.sin(a) * sp, 0.45 + R() * 0.55, 2.2 + R() * 2.4, 0.4, 1, 0.42 + R() * 0.38, 0.08, 1, 9, 1.6, e.gy);
        }
        // 帶重力的火星
        for (let i = 0; i < 14 * big; i++) {
          const a = R() * Math.PI * 2, sp = 6 + R() * 16;
          f.spawn(e.x, e.y, e.z, Math.cos(a) * sp, 8 + R() * 14, Math.sin(a) * sp, 0.7 + R() * 0.7, 0.45, 0.1, 1, 0.85, 0.4, 1, 26, 0.4, e.gy);
        }
        // 濃煙柱
        for (let i = 0; i < 16 * big; i++) {
          const a = R() * Math.PI * 2, sp = R() * e.r * 0.75;
          sm.spawn(e.x, e.y + 0.5, e.z, Math.cos(a) * sp, 2.5 + R() * 5, Math.sin(a) * sp, 1.2 + R() * 1.2, 2.2, 7 + R() * 4, 0.12, 0.11, 0.11, 0.72, -1.2, 1.2);
        }
        this.blast.spawn(e.x, e.y, e.z, e.gy, e.r);
        if (e.y - e.gy < 3.5) this.scorch.add(e.x, e.gy, e.z, e.r * (e.kart ? 1.1 : 0.85));
        this.debris?.burst(e.x, e.y, e.z, e.gy, e.kart ? 7 : 3, e.kart ? 15 : 10);
        const d = Math.hypot(e.x - p.x, e.z - p.z);
        this.addShake(clamp(1 - d / 80, 0, 1) * 0.85);
        break;
      }
      case 'ram': {
        // 撞擊：力道越大火花越多
        const n = Math.min(26, 5 + Math.round(e.power * 1.6));
        this.sparks(e.x, e.y, e.z, n, 10 + e.power, e.a.y, (e.a.vx + e.b.vx) * 0.5, (e.a.vz + e.b.vz) * 0.5);
        if (e.power > 5) this.debris?.burst(e.x, e.y, e.z, e.a.y, 1, 7);
        if (e.a === p || e.b === p) this.addShake(Math.min(0.6, 0.12 + e.power * 0.04));
        break;
      }
      case 'launch': {
        const fx = Math.sin(e.k.heading), fz = Math.cos(e.k.heading);
        if (e.kind === 'mine' || e.kind === 'cluster') {
          for (let i = 0; i < 6; i++) sm.spawn(e.k.x - fx * 1.8, e.k.y + 0.6, e.k.z - fz * 1.8, (R() - 0.5) * 3, 1 + R(), (R() - 0.5) * 3, 0.5, 0.8, 2.2, 0.8, 0.8, 0.8, 0.45);
          if (e.k === p) this.addShake(0.06);
          break;
        }
        for (let i = 0; i < 6; i++) sm.spawn(e.k.x + fx * 1.4, e.k.y + 1, e.k.z + fz * 1.4, e.k.vx + (R() - 0.5) * 4, 1 + R() * 2, e.k.vz + (R() - 0.5) * 4, 0.5, 0.8, 2.6, 0.85, 0.85, 0.85, 0.5);
        f.spawn(e.k.x + fx * 1.6, e.k.y + 1, e.k.z + fz * 1.6, e.k.vx, 0, e.k.vz, 0.1, 3.2, 1, 1, 0.75, 0.35, 1);
        if (e.k === p) this.addShake(e.kind === 'grenade' ? 0.3 : 0.14);
        break;
      }
      case 'start': {
        const k = e.k;
        for (let i = 0; i < 20; i++) {
          const a = (i / 20) * Math.PI * 2;
          f.spawn(k.x, k.y + 0.5, k.z, Math.cos(a) * 8, 1 + R() * 3, Math.sin(a) * 8, 0.4, 1.8, 0.2, 1, 0.7, 0.25, 1);
        }
        break;
      }
      case 'kart': {
        const k = e.k;
        if (e.e === 'wall') {
          this.sparks(k.x, k.y + 0.6, k.z, 12, 14, k.y);
          if (k === p) this.addShake(0.35);
        } else if (e.e === 'boost' || e.e === 'mini' || e.e === 'pad') {
          const blue = e.e === 'boost';
          for (let i = 0; i < 16; i++) {
            const a = (i / 16) * Math.PI * 2;
            f.spawn(k.x, k.y + 0.6, k.z, k.vx * 0.6 + Math.cos(a) * 7, R() * 3, k.vz * 0.6 + Math.sin(a) * 7, 0.35, 1.7, 0.2, blue ? 0.3 : 1, blue ? 0.8 : 0.65, blue ? 1 : 0.2, 1);
          }
          if (blue && k === p) this.addShake(0.22);
        } else if (e.e === 'n2o') {
          for (let i = 0; i < 14; i++) {
            const a = (i / 14) * Math.PI * 2;
            f.spawn(k.x + Math.cos(a) * 1.6, k.y + 0.3, k.z + Math.sin(a) * 1.6, k.vx, 5 + R() * 2, k.vz, 0.45, 1.1, 0.2, 0.35, 0.85, 1, 1);
          }
        } else if (e.e === 'land') {
          // 落地：揚起一圈塵土
          for (let i = 0; i < 14; i++) {
            const a = (i / 14) * Math.PI * 2;
            sm.spawn(k.x + Math.cos(a) * 1.2, k.y + 0.2, k.z + Math.sin(a) * 1.2, k.vx * 0.3 + Math.cos(a) * 5, 0.8 + R(), k.vz * 0.3 + Math.sin(a) * 5, 0.6, 1, 3.6, 0.85, 0.8, 0.7, 0.5, -0.4, 2);
          }
          this.sparks(k.x, k.y + 0.2, k.z, 6, 10, k.y);
          if (k === p) this.addShake(0.3);
        }
        break;
      }
      case 'respawn':
        for (let i = 0; i < 24; i++) {
          const a = (i / 12) * Math.PI * 2;
          f.spawn(e.k.x + Math.cos(a) * 1.8, e.k.y + (i < 12 ? 0.3 : 1.6), e.k.z + Math.sin(a) * 1.8, 0, 4 + R() * 3, 0, 0.6, 1.3, 0.2, 0.5, 1, 0.7, 1);
        }
        break;
    }
  }

  update(dt: number, race: Race, lookBack: boolean): void {
    this.time += dt;
    const R = Math.random;
    const f = this.fire, sm = this.smoke;
    const track = race.track;
    const wallLat = track.halfWidth - 1.05;
    const p = race.player;

    for (const k of race.karts) {
      const kv = this.kartViews.get(k);
      if (!kv) continue;
      // ---- 被擊毀：殘骸翻滾燃燒，重生時恢復 ----
      if (k.dead) {
        if (!kv.wrecked) kv.startWreck();
        if (k.out && kv.wreckT > 4) {
          kv.group.visible = false;
        } else {
          kv.updateWreck(dt, k.surface(track).y);
          const g = kv.group.position;
          if (R() < dt * 40) sm.spawn(g.x, g.y + 0.6, g.z, (R() - 0.5) * 2, 2 + R() * 2, (R() - 0.5) * 2, 1.1, 1.2, 4.2, 0.09, 0.09, 0.09, 0.65, -1, 0.8);
          if (R() < dt * 45) f.spawn(g.x + (R() - 0.5), g.y + 0.5, g.z + (R() - 0.5), 0, 2 + R() * 3, 0, 0.35, 1.8, 0.3, 1, 0.5, 0.1, 0.9);
        }
        this.skid.wheel(k, 0, false, 0, 0, 0, 0, 0);
        this.skid.wheel(k, 1, false, 0, 0, 0, 0, 0);
        const g0 = kv.group.position;
        for (let w = 0; w < 2; w++) {
          this.trails.push(k.id * 2 + w, g0.x, g0.y, g0.z, 0, 0, 0, 0);
          this.streaks.push(k.id * 2 + w, g0.x, g0.y, g0.z, 0, 0, 0, 0);
        }
        continue;
      }
      if (kv.wrecked) kv.endWreck();
      kv.update(k, dt);
      kv.fitName(this.camera.position.distanceTo(kv.group.position));

      const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
      const lx = fz, lz = -fx;
      const grounded = k.air <= 0;
      const sliding = grounded && (k.drifting ? Math.abs(k.slip) > 0.12 : (k.aiAssist && Math.abs(k.steerVis) > 0.75 && k.speed > 20) || Math.abs(k.spinVel) > 0.6);
      // 後輪位置：胎痕與輪胎煙
      for (let w = 0; w < 2; w++) {
        const side = w === 0 ? 1 : -1;
        const wx = k.x + lx * side * 0.55 - fx * 0.68, wz = k.z + lz * side * 0.55 - fz * 0.68;
        this.skid.wheel(k, w, sliding, wx, k.y + 0.035, wz, lx, lz);
        if (!sliding) continue;
        if (R() < dt * 50) {
          sm.spawn(wx, k.y + 0.25, wz, k.vx * 0.15 + (R() - 0.5) * 1.2, 0.8 + R(), k.vz * 0.15 + (R() - 0.5) * 1.2, 0.5 + R() * 0.5, 1, 3.4, 0.94, 0.94, 0.96, 0.5, -0.5, 1);
        }
        // 拖得夠久會磨出火花
        if (k.drifting && k.driftTime > 0.7 && R() < dt * 55) {
          const hot = k.driftTime > 1.8;
          f.spawn(wx, k.y + 0.12, wz, k.vx * 0.3 - fx * 3 + (R() - 0.5) * 5, 1.5 + R() * 4, k.vz * 0.3 - fz * 3 + (R() - 0.5) * 5, 0.2 + R() * 0.25, 0.42, 0.08, hot ? 0.45 : 1, hot ? 0.8 : 0.72, hot ? 1 : 0.25, 1, 16, 0, k.y);
        }
      }
      // 貼著護欄磨：持續噴火花
      if (grounded && Math.abs(k.lat) > (k.branch ? k.branch.halfWidth - 1.05 : wallLat) && Math.abs(k.speed) > 10) {
        const sm0 = k.surface(track);
        const sg = Math.sign(k.lat);
        const cx = k.x + sm0.nx * sg * 1.0, cz = k.z + sm0.nz * sg * 1.0;
        const cnt = Math.min(4, Math.round(dt * 150));
        for (let i = 0; i < cnt; i++) f.spawn(cx, k.y + 0.3 + R() * 0.6, cz, k.vx * 0.5 - sm0.nx * sg * (2 + R() * 5), 1 + R() * 5, k.vz * 0.5 - sm0.nz * sg * (2 + R() * 5), 0.2 + R() * 0.25, 0.45, 0.08, 1, 0.75, 0.3, 1, 18, 0, k.y);
        if (k === p) this.addShake(dt * 0.6);
      }
      if (k.boostT > 0 || k.miniT > 0 || k.padT > 0) {
        const blue = k.boostT > 0;
        const cnt = blue ? 3 : 1;
        for (let i = 0; i < cnt; i++) {
          const side = R() > 0.5 ? 0.3 : -0.3;
          f.spawn(k.x + lx * side - fx * 1.6, k.y + 0.6, k.z + lz * side - fz * 1.6, k.vx * 0.4 - fx * 7, R() * 0.6, k.vz * 0.4 - fz * 7, 0.24, 1.2, 0.15, blue ? 0.35 : 1, blue ? 0.75 : 0.6, blue ? 1 : 0.2, 0.5);
        }
      }
      // 破風：N2O 時車身兩側拖出藍色氣流；甩尾時兩個後輪後方拖出貼地的亮白光痕
      {
        const boost = k.boostT > 0;
        const drift = grounded && k.speed > 16 && (k.drifting ? Math.abs(k.slip) > 0.1 : sliding);
        const dk = drift ? clamp(Math.abs(k.slip) * 2.4 + (k.aiAssist ? 0.45 : 0.15), 0.35, 0.95) : 0;
        for (let w = 0; w < 2; w++) {
          const side = w === 0 ? 1 : -1;
          this.trails.push(k.id * 2 + w, k.x + lx * side * 1.0 - fx * 0.75, k.y + 1.0, k.z + lz * side * 1.0 - fz * 0.75, boost ? 1 : 0, 0.35, 0.8, 1.6);
          const wx = k.x + lx * side * 0.6 - fx * 0.75, wz = k.z + lz * side * 0.6 - fz * 0.75;
          this.streaks.push(k.id * 2 + w, wx, k.y + 0.06, wz, dk, 0.75, 0.85, 1.05, lx, 0, lz);
        }
      }
      // 火焰發射器：從兩側噴嘴往前噴出火舌
      if (k.firing > 0 && PRIMARY[k.primary].kind === 'flame') {
        const cnt = this.mobile ? 2 : 4;
        for (let i = 0; i < cnt; i++) {
          const side = i % 2 ? 0.7 : -0.7;
          const a = (R() - 0.5) * 0.36, sp = 24 + R() * 10;
          const dx = Math.sin(k.heading + a), dz = Math.cos(k.heading + a);
          f.spawn(k.x + lx * side + fx * 2.1, k.y + 0.97, k.z + lz * side + fz * 2.1, k.vx + dx * sp, 1 + R() * 2, k.vz + dz * sp, 0.45 + R() * 0.3, 0.6, 3.2, 1, 0.45 + R() * 0.3, 0.1, 0.85, -2, 2.2, k.y);
        }
        if (R() < dt * 20) sm.spawn(k.x + fx * 14, k.y + 1.5, k.z + fz * 14, k.vx * 0.6, 2, k.vz * 0.6, 0.9, 1.5, 4, 0.15, 0.13, 0.12, 0.45, -1, 1);
      }
      // 著火：車身冒火
      if (k.burnT > 0 && R() < dt * 40) {
        f.spawn(k.x + (R() - 0.5) * 1.4, k.y + 0.8, k.z + (R() - 0.5) * 1.4, k.vx * 0.7, 2 + R() * 2, k.vz * 0.7, 0.4, 1.2, 0.3, 1, 0.5, 0.1, 0.9);
      }
      // 尾流：白色氣流線從車身兩側往後流
      if (k.drafting && k === p) {
        for (let i = 0; i < 2; i++) {
          const side = (R() - 0.5) * 3.4;
          f.spawn(k.x + lx * side + fx * (2 + R() * 4), k.y + 0.4 + R() * 1.6, k.z + lz * side + fz * (2 + R() * 4), k.vx * 0.25, 0, k.vz * 0.25, 0.22, 0.5, 0.12, 0.85, 0.95, 1, 0.7);
        }
      }
      // 受損冒煙，瀕死時著火
      const hpR = k.hp / k.maxHp;
      if (hpR < 0.5 && R() < dt * (hpR < 0.25 ? 22 : 10)) {
        sm.spawn(k.x - fx * 0.9, k.y + 1, k.z - fz * 0.9, k.vx * 0.3, 1.6 + R(), k.vz * 0.3, 0.9, 0.8, 2.8, 0.1, 0.1, 0.1, 0.6, -1, 0.8);
        if (hpR < 0.25) f.spawn(k.x - fx * 0.9, k.y + 0.9, k.z - fz * 0.9, k.vx * 0.5, 1.5 + R() * 2, k.vz * 0.5, 0.3, 1.2, 0.3, 1, 0.5, 0.1, 0.9);
      }
    }

    // 爆炸桶：引爆後消失，重生前不顯示；即將連鎖引爆時發白光
    for (let i = 0; i < this.barrels.length; i++) {
      const b = race.barrels[i], m = this.barrels[i];
      m.visible = b.respawnT <= 0;
      m.material = b.fuse > 0 ? this.barrelHot : this.barrelMat;
      // 剛重生時從地面長出來（只是畫面效果，進度記在網格自己身上）
      if (!m.visible) m.userData.grow = 0;
      else {
        m.userData.grow = Math.min(1, (m.userData.grow ?? 1) + dt * 2.5);
        m.scale.setScalar(Math.max(0.05, m.userData.grow));
      }
    }

    // 曳光彈
    const B = race.bullets;
    const nb = Math.min(B.length, MAX_TRACERS);
    for (let i = 0; i < nb; i++) {
      const b = B[i];
      this.q.setFromAxisAngle(this.up, Math.atan2(b.vx, b.vz));
      this.m4.compose(this.v3.set(b.x, b.y, b.z), this.q, this.one);
      this.tracers.setMatrixAt(i, this.m4);
    }
    this.tracers.count = nb;
    this.tracers.instanceMatrix.needsUpdate = true;

    // 火箭與砲彈
    for (let i = 0; i < POOL; i++) {
      const mm = this.missiles[i];
      const m = race.missiles[i];
      mm.visible = !!m;
      if (m) {
        mm.position.set(m.x, m.y, m.z);
        mm.rotation.set(0, m.a, this.time * 9);
        mm.scale.setScalar(m.homing ? 1.35 : 1);
        if (m.homing && R() < 0.6) f.spawn(m.x, m.y, m.z, 0, 0, 0, 0.12, 1.2, 0.2, 1, 0.25, 0.2, 1);
        const bx = Math.sin(m.a), bz = Math.cos(m.a);
        for (let j = 0; j < 2; j++) sm.spawn(m.x - bx * (0.8 + j), m.y, m.z - bz * (0.8 + j), (R() - 0.5) * 1.5, R(), (R() - 0.5) * 1.5, 0.6, 0.6, 2.1, 0.92, 0.92, 0.92, 0.5);
        f.spawn(m.x - bx * 0.9, m.y, m.z - bz * 0.9, 0, 0, 0, 0.09, 1.8, 0.5, 1, 0.62, 0.2, 1);
      }
      const ss = this.shells[i];
      const s = race.shells[i];
      ss.visible = !!s;
      if (s) {
        ss.position.set(s.x, s.gy + s.y, s.z);
        sm.spawn(s.x, s.gy + s.y, s.z, 0, 0, 0, 0.4, 0.5, 1.4, 0.3, 0.3, 0.3, 0.45);
        if (R() < 0.5) f.spawn(s.x, s.gy + s.y, s.z, 0, 0, 0, 0.1, 1, 0.3, 1, 0.5, 0.15, 0.8);
      }
    }

    // 地雷：還沒啟動時亮黃燈，啟動後紅燈閃爍；集束圓雷快爆炸時閃得更快
    let nm = 0, nc = 0;
    for (const m of race.mines) {
      const blink = m.armT > 0 ? 1 : (m.kind === 'cluster' && m.life < 1.6 ? Math.floor(this.time * 12) : Math.floor(this.time * 4 + m.x)) % 2;
      if (m.armT > 0) this.col.setRGB(1.5, 1.1, 0.1);
      else if (blink) this.col.setRGB(2.2, 0.06, 0.04);
      else this.col.setRGB(0.25, 0.04, 0.03);
      this.m4.makeTranslation(m.x, m.y + 0.02, m.z);
      if (m.kind === 'mine' && nm < MAX_MINES) {
        this.mineBody.setMatrixAt(nm, this.m4);
        this.mineLight.setMatrixAt(nm, this.m4);
        this.mineLight.setColorAt(nm, this.col);
        nm++;
      } else if (m.kind === 'cluster' && nc < MAX_CLUSTER) {
        this.clusterBody.setMatrixAt(nc, this.m4);
        this.clusterLight.setMatrixAt(nc, this.m4);
        this.clusterLight.setColorAt(nc, this.col);
        nc++;
      }
    }
    this.mineBody.count = this.mineLight.count = nm;
    this.clusterBody.count = this.clusterLight.count = nc;
    for (const im of [this.mineBody, this.mineLight, this.clusterBody, this.clusterLight]) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
    this.hazardView?.update(race, this.time);

    this.trails.update();
    this.streaks.update();
    this.scorch.update(dt);
    this.blast.update(dt);
    this.debris?.update(dt);
    this.shards.update(dt);
    sm.update(dt);
    f.update(dt);
    if (this.theme.night) {
      const hx = Math.sin(p.heading), hz = Math.cos(p.heading);
      this.headlight.position.set(p.x + hx * 1.2, p.y + 1.7, p.z + hz * 1.2);
      this.headlight.target.position.set(p.x + hx * 32, p.y - 0.5, p.z + hz * 32);
    }
    this.updateChaseCam(dt, p, lookBack);
    this.updateWeather(dt, p.vx, p.vz);
    this.world?.update(dt, this.time, this.camera);
    this.updateSun(p.x, p.y - p.air, p.z);
  }

  /** 天氣跟著鏡頭；閃電時把環境光短暫調亮 */
  private updateWeather(dt: number, vx: number, vz: number): void {
    const w = this.weather;
    if (!w) return;
    w.update(dt, this.time, this.camera, vx, vz);
    const th = this.theme;
    this.hemi.intensity = th.hemiIntensity + w.flash * 2.4;
    this.sun.intensity = th.sunIntensity + w.flash * 1.5;
  }

  /** 陰影範圍跟著玩家移動，並往鏡頭前方挪（以固定格距對齊，避免陰影邊緣閃爍） */
  private updateSun(x: number, y: number, z: number): void {
    const g = 4;
    const f = this.camera.getWorldDirection(this.v3);
    const fl = Math.hypot(f.x, f.z) || 1;
    x += (f.x / fl) * 30;
    z += (f.z / fl) * 30;
    this.sun.target.position.set(Math.round(x / g) * g, y, Math.round(z / g) * g);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, 220);
    this.rim.target.position.copy(this.sun.target.position);
    this.rim.position.set(this.sun.target.position.x - this.sunDir.x * 100, this.sun.target.position.y + 40, this.sun.target.position.z - this.sunDir.z * 100);
  }

  private updateChaseCam(dt: number, k: Kart, lookBack: boolean): void {
    const want = k.heading + k.slip * 0.55;
    this.camYaw = lerpAngle(this.camYaw, want, 1 - Math.exp(-5.5 * dt));
    // 鏡頭高度跟著路面走；飛起來時只跟一部分，才看得出車離地了
    const targetY = k.y - k.air * 0.55;
    this.camY += (targetY - this.camY) * (1 - Math.exp(-10 * dt));
    const yaw = this.camYaw + (lookBack ? Math.PI : 0);
    const dx = Math.sin(yaw), dz = Math.cos(yaw);
    const bk = k.boostT > 0 ? 1 : k.padT > 0 ? 0.7 : k.miniT > 0 ? 0.5 : 0;
    this.boostK += (bk - this.boostK) * Math.min(1, dt * 5);
    const ratio = clamp(k.speed / k.topSpeed, 0, 1.4);
    const dist = 8.6 + this.boostK * 1.6;
    // 震動：強度平方 × 幾個不同頻率的正弦波相加（比每幀亂數平滑）
    this.shake = Math.max(0, this.shake - dt * 1.9);
    this.shakeT += dt * 34;
    const sh = this.shake * this.shake * 0.6;
    const t = this.shakeT;
    const slope = Math.tan(clamp(k.air > 0 ? 0 : k.pitch, -0.3, 0.3)) * (lookBack ? -1 : 1);
    this.camera.position.set(
      k.x - dx * dist + Math.sin(t * 1.7) * sh,
      this.camY + 4.5 - slope * dist * 0.5 + Math.sin(t * 2.3) * sh,
      k.z - dz * dist + Math.sin(t * 1.3 + 1) * sh,
    );
    this.camera.lookAt(k.x + dx * 6, this.camY + 1.7 + slope * 6, k.z + dz * 6);
    this.driftRoll += ((k.drifting ? clamp(k.slip, -0.6, 0.6) * 0.09 : 0) - this.driftRoll) * Math.min(1, dt * 5);
    this.camera.rotateZ(Math.sin(t * 1.1) * sh * 0.05 + this.driftRoll * (lookBack ? -1 : 1));
    const fov = 64 + ratio * 9 + this.boostK * 14;
    this.fov += (fov - this.fov) * Math.min(1, dt * 6);
    if (Math.abs(this.camera.fov - this.fov) > 0.05) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
      this.updateParticleScale();
    }
  }

  /** 主選單背景：沿賽道飛行 */
  updateMenuCam(dt: number): void {
    const tr = this.track;
    if (!tr) return;
    this.time += dt;
    const n = tr.n;
    const fi = ((this.time * 18) / tr.spacing) % n;
    const i = Math.floor(fi);
    const a = tr.samples[i], b = tr.samples[(i + 1) % n];
    const u = fi - i;
    const c = tr.samples[(i + 34) % n];
    const x = a.x + (b.x - a.x) * u, z = a.z + (b.z - a.z) * u, y = a.y + (b.y - a.y) * u;
    this.camera.position.set(x, y + 9, z);
    this.camera.lookAt(c.x, c.y + 1.5, c.z);
    if (this.camera.fov !== 66) {
      this.camera.fov = 66;
      this.camera.updateProjectionMatrix();
      this.updateParticleScale();
    }
    this.boostK = 0;
    this.updateWeather(dt, 0, 0);
    this.world?.update(dt, this.time, this.camera);
    this.updateSun(x, y, z);
  }

  render(): void {
    this.trackFrame(performance.now());
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /**
   * 動態解析度：每 1 秒算一次平均幀耗時。連續 2 秒低於約 49 FPS 就降一階像素比，
   * 連續 4 秒高於約 57 FPS 就升一階；剛升上去就變慢代表那一階撐不住，之後等更久才再試（避免來回跳）。
   */
  private trackFrame(now: number): void {
    const dt = now - this.frameLast;
    this.frameLast = now;
    // 分頁切走、載入卡頓這種超長的幀不算
    if (!this.dynRes || dt <= 0 || dt > 100 || now < this.resHold || this.resMax - this.resMin < 0.01) {
      this.frameN = 0;
      this.frameSum = 0;
      return;
    }
    if (this.frameN === 0) this.winStart = now - dt;
    this.frameSum += dt;
    this.frameN++;
    if (now - this.winStart < 1000) return;
    const avg = this.frameSum / this.frameN;
    this.frameN = 0;
    this.frameSum = 0;
    if (avg > 20.5) {
      this.slowWins++;
      this.fastWins = 0;
    } else if (avg < 17.6) {
      this.fastWins++;
      this.slowWins = 0;
    } else {
      this.slowWins = 0;
      this.fastWins = Math.max(0, this.fastWins - 1);
    }
    if (now - this.resChangedAt < 2000) return;
    const step = 0.125;
    if (this.slowWins >= 2 && this.resScale > this.resMin + 0.001) {
      if (now - this.resUpAt < 6000) {
        this.resUpBlock = now + this.resBackoff;
        this.resBackoff = Math.min(this.resBackoff * 2, 160000);
        this.resUpAt = -1e9;
      }
      // 慢很多（不到 36 FPS）就一次降兩階
      this.setResScale(this.resScale - (avg > 28 ? step * 2 : step), now);
    } else if (this.fastWins >= 4 && this.resScale < this.resMax - 0.001 && now > this.resUpBlock) {
      this.resUpAt = now;
      this.setResScale(this.resScale + step, now);
    }
  }

  /** 換像素比：畫布、後製畫框（含泛光）與粒子大小一起跟著調整 */
  setResScale(v: number, now = performance.now()): void {
    v = clamp(Math.round(v * 1000) / 1000, this.resMin, this.resMax);
    if (Math.abs(v - this.resScale) < 0.001) return;
    this.resScale = v;
    this.resChangedAt = now;
    this.slowWins = this.fastWins = 0;
    // 換解析度那一下會卡一點，之後半秒的幀不算，新的量測區間只看新解析度
    this.resHold = Math.max(this.resHold, now + 500);
    this.renderer.setPixelRatio(v);
    this.resize();
  }
}
