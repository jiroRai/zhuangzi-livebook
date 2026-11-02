// 书的模型：精装封面、书脊、两叠书页，以及会卷曲的单张书页
import * as THREE from 'three';
import { clamp, lerp } from './util.js';

export const W = 1;          // 页宽
export const H = 1.4;        // 页高
export const TB = 0.024;     // 封面纸板厚
export const OV = 0.03;      // 封面比书页多出的边
export const T = 0.11;       // 整本书页的厚度
const LAMBDA = 0.11;         // 书页靠近书脊处的弯曲长度
const NS = 44, NZ = 10;      // 书页网格

// 书页在书脊处隆起：角度 φ(s) = α·e^(−s/λ)，隆起高度 = λ·Si(α)
const SI = (() => {
  const n = 400, tab = new Float32Array(n + 1);
  let acc = 0;
  for (let i = 1; i <= n; i++) {
    const a = (i - 0.5) / n * 2.6;
    acc += Math.sin(a) / a * (2.6 / n);
    tab[i] = acc;
  }
  return tab;
})();
function alphaFor(h) {
  const target = h / LAMBDA;
  for (let i = 1; i < SI.length; i++) if (SI[i] >= target) return i / (SI.length - 1) * 2.6;
  return 2.6;
}

// s 在书脊附近更密
const S = new Float32Array(NS + 1);
for (let i = 0; i <= NS; i++) S[i] = W * Math.pow(i / NS, 1.45);

// 计算一条横截面曲线（x,y），供书页与书块共用
const tmpPhi = new Float32Array(NS + 1);
function profile(out, alphaR, alphaL, e, bend, twistK) {
  // out: Float32Array (NS+1)*2
  let x = 0, y = 0;
  out[0] = 0; out[1] = 0;
  for (let i = 0; i <= NS; i++) {
    const s = S[i];
    const pr = alphaR * Math.exp(-s / LAMBDA);
    const pl = Math.PI - alphaL * Math.exp(-s / LAMBDA);
    let p = lerp(pr, pl, e) + bend * twistK * Math.pow(s / W, 1.5);
    tmpPhi[i] = clamp(p, pr, pl);
  }
  for (let i = 1; i <= NS; i++) {
    const ds = S[i] - S[i - 1];
    const p = (tmpPhi[i] + tmpPhi[i - 1]) * 0.5;
    x += Math.cos(p) * ds; y += Math.sin(p) * ds;
    out[i * 2] = x; out[i * 2 + 1] = y;
  }
  return out;
}

// 单张书页：正面（右页）与背面（左页）共用顶点
export class Leaf {
  constructor() {
    const nv = (NS + 1) * (NZ + 1);
    this.pos = new THREE.BufferAttribute(new Float32Array(nv * 3), 3);
    this.nrm = new THREE.BufferAttribute(new Float32Array(nv * 3), 3);
    const uvF = new Float32Array(nv * 2), uvB = new Float32Array(nv * 2);
    const idx = [];
    for (let j = 0; j <= NZ; j++) for (let i = 0; i <= NS; i++) {
      const k = j * (NS + 1) + i;
      const u = S[i] / W, v = 1 - j / NZ;
      uvF[k * 2] = u; uvF[k * 2 + 1] = v;
      uvB[k * 2] = 1 - u; uvB[k * 2 + 1] = v;
      if (i < NS && j < NZ) {
        const a = k, b = k + 1, c = k + NS + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const mk = (uv) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', this.pos);
      g.setAttribute('normal', this.nrm);
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(idx);
      return g;
    };
    this.geoF = mk(uvF);
    this.geoB = mk(uvB);
    this.matF = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, side: THREE.FrontSide });
    this.matB = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, side: THREE.BackSide });
    this.front = new THREE.Mesh(this.geoF, this.matF);
    this.back = new THREE.Mesh(this.geoB, this.matB);
    for (const m of [this.front, this.back]) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; }
    this.group = new THREE.Group();
    this.group.add(this.front, this.back);
    this.prof = new Float32Array((NS + 1) * 2);
    this.t = 0;
  }
  setMaps(front, back) {
    if (this.matF.map !== front) { this.matF.map = front; this.matF.needsUpdate = true; }
    if (this.matB.map !== back) { this.matB.map = back; this.matB.needsUpdate = true; }
  }
  // t: 0 平躺在右，1 平躺在左；hR/hL：两侧书叠高度；bend：卷曲；twist：斜角掀起
  shape(t, hR, hL, bend = 0, twist = 0) {
    this.t = t;
    const aR = alphaFor(hR), aL = alphaFor(hL);
    const p = this.pos.array;
    for (let j = 0; j <= NZ; j++) {
      const zn = j / NZ * 2 - 1;
      const z = -H / 2 + (j / NZ) * H;
      profile(this.prof, aR, aL, t, bend, 1 + twist * zn);
      for (let i = 0; i <= NS; i++) {
        const k = (j * (NS + 1) + i) * 3;
        p[k] = this.prof[i * 2];
        p[k + 1] = this.prof[i * 2 + 1];
        p[k + 2] = z;
      }
    }
    this.pos.needsUpdate = true;
    computeNormals(this.geoF);
    // 页面平坦部分的高度，用来摆放立体插图
    return this;
  }
}

function computeNormals(g) {
  g.computeVertexNormals();
  g.attributes.normal.needsUpdate = true;
}

// 平坦区域的高度（相对书脊铰点）
export const flatHeight = (h) => LAMBDA * siOf(alphaFor(h));
function siOf(a) { return SI[Math.round(a / 2.6 * (SI.length - 1))]; }

// —— 材质纹理 ——
function canvasTex(w, h, draw, { repeat, srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
  t.anisotropy = 8;
  return t;
}

function clothDraw(base, thread) {
  return (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 2) { g.fillStyle = `rgba(255,255,255,${0.025 + Math.random() * 0.03})`; g.fillRect(0, y, w, 1); }
    for (let x = 0; x < w; x += 2) { g.fillStyle = `rgba(0,0,0,${0.04 + Math.random() * 0.05})`; g.fillRect(x, 0, 1, h); }
    for (let i = 0; i < 1400; i++) { g.fillStyle = thread; g.globalAlpha = Math.random() * 0.12; g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 6, 1); }
    g.globalAlpha = 1;
  };
}

export function makeTextures(fonts) {
  const cloth = canvasTex(256, 256, clothDraw('#2d4356', '#9fb4c4'), { repeat: [3, 4] });
  // 封面：布面 + 题签 + 小印
  const coverTex = canvasTex(1024, 1408, (g, w, h) => {
    clothDraw('#2d4356', '#9fb4c4')(g, w, h);
    // 压出的边框
    g.strokeStyle = 'rgba(0,0,0,.22)'; g.lineWidth = 3; g.strokeRect(46, 46, w - 92, h - 92);
    g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 2; g.strokeRect(50, 50, w - 100, h - 100);
    // 题签
    const sx = w - 300, sy = 120, sw = 170, sh = 600;
    g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(sx + 5, sy + 7, sw, sh);
    const grd = g.createLinearGradient(sx, sy, sx + sw, sy + sh);
    grd.addColorStop(0, '#f3ead6'); grd.addColorStop(1, '#e8dcc0');
    g.fillStyle = grd; g.fillRect(sx, sy, sw, sh);
    g.strokeStyle = '#7a3a2a'; g.lineWidth = 2.5; g.strokeRect(sx + 12, sy + 12, sw - 24, sh - 24);
    g.lineWidth = 1; g.strokeRect(sx + 18, sy + 18, sw - 36, sh - 36);
    g.fillStyle = '#231f1b'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `112px ${fonts.brush}`;
    g.fillText('庄', sx + sw / 2, sy + 150);
    g.fillText('子', sx + sw / 2, sy + 290);
    g.font = `30px ${fonts.serif}`;
    ['内', '外', '杂', '篇'].forEach((c, i) => g.fillText(c, sx + sw / 2, sy + 400 + i * 40));
    // 小印
    g.fillStyle = '#a8402c'; g.fillRect(sx + sw / 2 - 26, sy + sh - 78, 52, 52);
    g.fillStyle = '#f3ead6'; g.font = `22px ${fonts.serif}`;
    g.fillText('南', sx + sw / 2 - 11, sy + sh - 64); g.fillText('华', sx + sw / 2 - 11, sy + sh - 40);
    g.fillText('真', sx + sw / 2 + 11, sy + sh - 64); g.fillText('经', sx + sw / 2 + 11, sy + sh - 40);
    // 底部压印的一行小字
    g.fillStyle = 'rgba(214,190,140,.55)'; g.font = `26px ${fonts.serif}`; g.textAlign = 'left';
    g.fillText('三十三篇 · 互动读本', 110, h - 130);
  });
  const endpaper = canvasTex(1024, 1408, (g, w, h) => {
    g.fillStyle = '#e9dcc2'; g.fillRect(0, 0, w, h);
    // 淡淡的水波纹
    g.strokeStyle = 'rgba(120,96,64,.13)'; g.lineWidth = 2;
    for (let y = 30; y < h; y += 44) for (let x = (y / 44 % 2) * 40; x < w + 80; x += 80) {
      g.beginPath(); g.arc(x, y, 30, Math.PI * 1.1, Math.PI * 1.9); g.stroke();
      g.beginPath(); g.arc(x, y, 18, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
    }
    for (let i = 0; i < 3000; i++) { g.fillStyle = `rgba(90,70,40,${Math.random() * 0.05})`; g.fillRect(Math.random() * w, Math.random() * h, 1, 1); }
  });
  // 书口：一层层纸的细纹
  const edges = canvasTex(64, 512, (g, w, h) => {
    g.fillStyle = '#efe5d0'; g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 2) { g.fillStyle = `rgba(110,90,60,${0.05 + Math.random() * 0.12})`; g.fillRect(0, y, w, 1); }
  });
  edges.wrapS = edges.wrapT = THREE.RepeatWrapping;
  return { cloth, coverTex, endpaper, edges };
}

// —— 整本书 ——
export class Book {
  constructor(tex) {
    this.tex = tex;
    this.group = new THREE.Group();
    const clothMat = new THREE.MeshStandardMaterial({ map: tex.cloth, roughness: 0.85, color: 0xffffff });
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0xe9e0cc, roughness: 0.9 });
    this.clothMat = clothMat;

    // 封底（右侧，承托右叠书页）
    const boardGeo = new THREE.BoxGeometry(W + OV, TB, H + OV * 2);
    const endMat = new THREE.MeshStandardMaterial({ map: tex.endpaper, roughness: 0.9 });
    const gutterMat = new THREE.MeshStandardMaterial({ color: 0xe6dcc6, roughness: 0.95 });
    // 订口一侧的板边用纸色，免得从书页缝里露出一道深色细线
    this.back = new THREE.Mesh(boardGeo, [clothMat, gutterMat, endMat, clothMat, clothMat, clothMat]);
    this.back.position.set((W + OV) / 2, TB / 2, 0);
    this.back.castShadow = this.back.receiveShadow = true;
    this.group.add(this.back);

    // 封面：铰链在书脊
    this.coverHinge = new THREE.Group();
    const coverTopMat = new THREE.MeshStandardMaterial({ map: tex.coverTex, roughness: 0.8 });
    this.coverTopMat = coverTopMat;
    const coverInMat = new THREE.MeshStandardMaterial({ map: tex.endpaper, roughness: 0.9 });
    this.cover = new THREE.Mesh(boardGeo, [clothMat, gutterMat, coverTopMat, coverInMat, clothMat, clothMat]);
    this.cover.position.set((W + OV) / 2, TB / 2, 0);
    this.cover.castShadow = this.cover.receiveShadow = true;
    this.coverHinge.add(this.cover);
    this.group.add(this.coverHinge);

    // 书脊
    this.spineHinge = new THREE.Group();
    const spineLen = T + TB * 2;
    this.spine = new THREE.Mesh(new THREE.BoxGeometry(spineLen, TB, H + OV * 2), clothMat);
    this.spine.position.set(spineLen / 2, -TB / 2, 0);
    this.spine.castShadow = true;
    this.spineHinge.add(this.spine);
    this.group.add(this.spineHinge);

    // 两叠书页（挤出的截面）
    this.edgeMat = new THREE.MeshStandardMaterial({ map: tex.edges, roughness: 0.95, color: 0xffffff, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 });
    this.blockR = new THREE.Mesh(new THREE.BufferGeometry(), [this.edgeMat, this.edgeMat]);
    this.blockL = new THREE.Mesh(new THREE.BufferGeometry(), [this.edgeMat, this.edgeMat]);
    for (const b of [this.blockR, this.blockL]) { b.castShadow = true; b.receiveShadow = true; this.group.add(b); }
    this.blockL.scale.x = -1;
    this.edgeMatSide = edgeMat;

    // 静止的左右页 + 翻动中的页
    this.pageR = new Leaf();
    this.pageL = new Leaf();
    for (const l of [this.pageR, this.pageL]) {
      l.front.castShadow = l.back.castShadow = false;
      l.group.position.y = TB;
      this.group.add(l.group);
    }
    this.flips = [];
    this.pool = [];

    // 丝带书签
    this.ribbon = this.makeRibbon();
    this.group.add(this.ribbon);

    this.coverOpen = 0;
    this.hR = T; this.hL = 0;
    this._blockKey = '';
    this.updateRibbon();
  }

  makeRibbon() {
    const n = 24, w = 0.022;
    const g = new THREE.PlaneGeometry(w, 1, 1, n);
    const m = new THREE.MeshStandardMaterial({ color: 0xa63f2c, roughness: 0.55, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this._ribN = n;
    return mesh;
  }

  // 丝带只随书叠高度变化，不再随时间摆动（一直轻摆会让它和纸面的交线不停闪）
  updateRibbon() {
    const p = this.ribbon.geometry.attributes.position;
    const n = this._ribN;
    const top = TB + Math.max(this.hR, this.hL) * 0.5 + 0.002;
    for (let i = 0; i <= n; i++) {
      const s = i / n;              // 0 在书里，1 在桌上的末端
      const len = 0.26;
      const z = H / 2 - 0.02 + s * len;
      const y = Math.max(0.0015, top * (1 - smoothStep(0, 0.35, s)) - 0.004 * s);
      const x = 0.05 + s * 0.06 + Math.sin(s * 3) * 0.004 * s;
      for (let k = 0; k < 2; k++) {
        const vi = i * 2 + k;
        const off = (k ? 0.5 : -0.5) * 0.022;
        p.setXYZ(vi, x + off, y + (s > 0.3 ? 0 : 0.0005), z);
      }
    }
    p.needsUpdate = true;
    this.ribbon.geometry.computeVertexNormals();
  }

  // 根据左右书叠的高度重建书块
  setHeights(hR, hL) {
    this.hR = hR; this.hL = hL;
    const key = hR.toFixed(4) + '|' + hL.toFixed(4);
    if (key === this._blockKey) return;
    this._blockKey = key;
    this.blockR.geometry.dispose(); this.blockL.geometry.dispose();
    this.blockR.geometry = blockGeometry(hR);
    this.blockL.geometry = blockGeometry(hL);
    this.blockR.visible = hR >= 0.005;
    this.blockL.visible = hL >= 0.005;
    this.updateRibbon();
  }

  getLeaf() {
    let l = this.pool.pop();
    if (!l) {
      l = new Leaf();
      // 翻动的页总在静止页之上（订口处尤其容易重叠）
      for (const m of [l.matF, l.matB]) { m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -4; }
    }
    l.group.visible = true;
    l.group.position.y = TB;
    this.group.add(l.group);
    return l;
  }
  releaseLeaf(l) { this.group.remove(l.group); this.pool.push(l); }

  // 封面开合：a = 0 合上，1 摊开在左侧
  setCover(a) {
    this.coverOpen = a;
    const ang = Math.PI * a;
    // 合上时封面内侧与第一页恰好同一平面，会抢深度闪烁；垫高一点点
    const top = TB + T + 0.0015;
    // 铰链从书顶落到桌面
    this.coverHinge.position.set(0, lerp(top, TB, smoothStep(0.05, 0.95, a)), 0);
    this.coverHinge.rotation.z = ang;
    // 抬起时，铰链略向外
    this.spineHinge.rotation.z = Math.PI / 2 + (Math.PI / 2) * smoothStep(0, 1, a);
  }
}

function smoothStep(a, b, x) { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); }

const tmpProf = new Float32Array((NS + 1) * 2);
function blockGeometry(h) {
  if (h < 0.005) return new THREE.BufferGeometry();
  profile(tmpProf, alphaFor(h), 0, 0, 0, 1);
  // 书块顶面比书页低一点，订口处也不会与书页重叠
  const shape = new THREE.Shape();
  shape.moveTo(0.004, 0);
  for (let i = 2; i <= NS; i++) shape.lineTo(tmpProf[i * 2], Math.max(0.0008, tmpProf[i * 2 + 1] - 0.0035));
  const xe = tmpProf[NS * 2];
  shape.lineTo(xe, 0);
  shape.lineTo(0, 0);
  const g = new THREE.ExtrudeGeometry(shape, { depth: H - 0.004, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, TB, -(H - 0.004) / 2);
  // 书口纹理：沿高度方向的细纹
  const uv = g.attributes.uv, pos = g.attributes.position;
  for (let i = 0; i < uv.count; i++) {
    const y = pos.getY(i), z = pos.getZ(i), x = pos.getX(i);
    uv.setXY(i, (x + z) * 0.5, y * 9);
  }
  return g;
}
