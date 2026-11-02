// 墨线工具：在 canvas 上用“毛笔”画线、上淡彩
// 坐标系：以画面底边中点为原点，x 向右，y 向上，单位与三维世界一致（页宽 = 1）
import { rng } from './util.js';

export const INK = '#26221e';
export const INK2 = 'rgba(38,34,30,.55)';
export const VERM = '#b0432d';
export const PAPER = '#f7f0e2';
export const PAPER_EDGE = '#d8c9ad';
export const WASH = {
  water: 'rgba(96,132,150,', ochre: 'rgba(196,150,84,', verm: 'rgba(176,67,45,', green: 'rgba(110,138,90,', ink: 'rgba(38,34,30,',
};
export const FONTS = {
  // 网页内嵌子集：宋体=Swei Sugar，楷体=方正欧蝶（+张颢补字），标题=Cooper
  serif: '"GJ-Song","Noto Serif SC","Noto Serif CJK SC","Source Han Serif SC","Songti SC","STSong","SimSun",serif',
  kai: '"GJ-Kai","GJ-KaiFallback","GJ-KaiExtB","GJ-KaiPua","LXGW WenKai","Kaiti SC","STKaiti","KaiTi","Noto Serif CJK SC",serif',
  title: '"GJ-Title","CooperZhengKai","GJ-Kai","KaiTi",serif',
  brush: '"Ma Shan Zheng","Kaiti SC","STKaiti","KaiTi","GJ-Kai",serif',
};


// Catmull-Rom 平滑
export function smoothPts(pts, seg = 8, closed = false) {
  if (pts.length < 3) return pts.slice();
  const out = [];
  const n = pts.length;
  const get = (i) => closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))];
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let k = 0; k < seg; k++) {
      const t = k / seg, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(closed ? pts[0] : pts[n - 1]);
  return out;
}

export const ellipsePts = (cx, cy, rx, ry, n = 40, a0 = 0, a1 = Math.PI * 2) => {
  const o = [];
  for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; o.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]); }
  return o;
};

export class Ink {
  // ctx：画布；scale：每单位像素；ox, oy：原点在画布上的像素位置
  constructor(ctx, scale, ox, oy, seed = 1) {
    this.c = ctx; this.k = scale; this.ox = ox; this.oy = oy;
    this.r = rng(seed);
    this.lit = 0;      // 点亮程度（0–1），供上色使用
    this.t = 0;        // 动画时间（需要时）
  }
  X(x) { return this.ox + x * this.k; }
  Y(y) { return this.oy - y * this.k; }

  // 毛笔线：两端收锋，中间饱满
  stroke(pts, w = 0.006, { color = INK, smooth = true, taper = [0.18, 0.3], alpha = 1, rough = 0.12, closed = false } = {}) {
    const c = this.c;
    let P = smooth ? smoothPts(pts, 6, closed) : pts;
    if (P.length < 2) return;
    P = P.map(([x, y]) => [this.X(x), this.Y(y)]);
    // 重采样
    const L = [0];
    for (let i = 1; i < P.length; i++) L.push(L[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    const total = L[L.length - 1];
    if (total < 0.5) return;
    const step = Math.max(1.2, total / 400);
    const Q = [];
    let j = 0;
    for (let d = 0; d <= total; d += step) {
      while (j < L.length - 2 && L[j + 1] < d) j++;
      const f = (d - L[j]) / Math.max(1e-6, L[j + 1] - L[j]);
      Q.push([P[j][0] + (P[j + 1][0] - P[j][0]) * f, P[j][1] + (P[j + 1][1] - P[j][1]) * f, d / total]);
    }
    Q.push([P[P.length - 1][0], P[P.length - 1][1], 1]);
    const wpx = w * this.k;
    const left = [], right = [];
    const ph = this.r() * 10;
    for (let i = 0; i < Q.length; i++) {
      const a = Q[Math.max(0, i - 1)], b = Q[Math.min(Q.length - 1, i + 1)];
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
      const t = Q[i][2];
      let pr = closed ? 1 : Math.min(1, t / taper[0], (1 - t) / taper[1]);
      pr = Math.pow(Math.max(0, pr), 0.6);
      const ww = wpx * (0.25 + 0.75 * pr) * (1 + rough * Math.sin(t * 23 + ph) * Math.sin(t * 7.3 + ph * 2)) / 2;
      left.push([Q[i][0] - dy * ww, Q[i][1] + dx * ww]);
      right.push([Q[i][0] + dy * ww, Q[i][1] - dx * ww]);
    }
    c.save();
    c.globalAlpha = alpha;
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(left[0][0], left[0][1]);
    for (const p of left) c.lineTo(p[0], p[1]);
    for (let i = right.length - 1; i >= 0; i--) c.lineTo(right[i][0], right[i][1]);
    c.closePath();
    c.fill();
    c.restore();
  }
  line(x0, y0, x1, y1, w = 0.005, o) { this.stroke([[x0, y0], [x1, y1]], w, { smooth: false, ...o }); }
  // 平滑多边形的路径
  path(pts, closed = true, smooth = true) {
    const c = this.c;
    const P = smooth ? smoothPts(pts, 6, closed) : pts;
    c.beginPath();
    P.forEach(([x, y], i) => i ? c.lineTo(this.X(x), this.Y(y)) : c.moveTo(this.X(x), this.Y(y)));
    if (closed) c.closePath();
  }
  fill(pts, color = PAPER, { smooth = true, alpha = 1 } = {}) {
    const c = this.c;
    c.save(); c.globalAlpha = alpha; c.fillStyle = color;
    this.path(pts, true, smooth); c.fill(); c.restore();
  }
  // 纸色底（挖空的纸片需要先铺底）
  paper(pts, o) { this.fill(pts, PAPER, o); }
  // 淡彩：边缘柔和
  wash(pts, color, a = 0.35, { blur = 6, smooth = true } = {}) {
    if (a <= 0.002) return;
    const c = this.c;
    c.save();
    c.filter = `blur(${blur}px)`;
    c.fillStyle = color + a + ')';
    this.path(pts, true, smooth); c.fill();
    c.restore();
  }
  // 闭合轮廓：纸底 + 墨线
  shape(pts, w = 0.006, { fill = PAPER, wash, washA = 0, color = INK, smooth = true } = {}) {
    if (fill) this.fill(pts, fill, { smooth });
    if (wash) this.wash(pts, wash, washA);
    this.stroke([...pts, pts[0]], w, { color, smooth, closed: true, taper: [0.02, 0.02] });
  }
  circle(cx, cy, r, w = 0.005, o = {}) {
    const pts = ellipsePts(cx, cy, r, r, 48).slice(0, -1);
    this.shape(pts, w, o);
  }
  dot(x, y, r, color = INK) {
    const c = this.c; c.save(); c.fillStyle = color; c.beginPath(); c.arc(this.X(x), this.Y(y), r * this.k, 0, Math.PI * 2); c.fill(); c.restore();
  }
  // 排线：在多边形内画斜线
  hatch(pts, { angle = 0.8, gap = 0.014, w = 0.0022, color = INK2 } = {}) {
    const c = this.c;
    c.save();
    this.path(pts, true, true); c.clip();
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const R = Math.hypot(x1 - x0, y1 - y0);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    for (let d = -R; d <= R; d += gap) {
      const ax = cx + ca * -R - sa * d, ay = cy + sa * -R + ca * d;
      const bx = cx + ca * R - sa * d, by = cy + sa * R + ca * d;
      this.stroke([[ax, ay], [bx, by]], w, { color, smooth: false, taper: [0.1, 0.1], rough: 0.3 });
    }
    c.restore();
  }
  // 文字（以单位坐标定位）
  text(str, x, y, size, { font = FONTS.serif, color = INK, align = 'center', base = 'middle', vertical = false, alpha = 1 } = {}) {
    const c = this.c;
    c.save(); c.globalAlpha = alpha;
    c.fillStyle = color; c.font = `${size * this.k}px ${font}`;
    c.textAlign = align; c.textBaseline = base;
    if (vertical) [...str].forEach((ch, i) => c.fillText(ch, this.X(x), this.Y(y - i * size * 1.05)));
    else c.fillText(str, this.X(x), this.Y(y));
    c.restore();
  }
  // 朱印
  seal(x, y, s, chars) {
    const c = this.c;
    c.save();
    c.fillStyle = VERM; c.globalAlpha = 0.9;
    c.fillRect(this.X(x - s / 2), this.Y(y + s / 2), s * this.k, s * this.k);
    c.fillStyle = PAPER; c.font = `${s * 0.4 * this.k}px ${FONTS.serif}`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    const q = s * 0.22;
    if (chars.length === 1) { c.font = `${s * 0.7 * this.k}px ${FONTS.serif}`; c.fillText(chars, this.X(x), this.Y(y)); }
    else if (chars.length === 2) { c.fillText(chars[0], this.X(x), this.Y(y + q)); c.fillText(chars[1], this.X(x), this.Y(y - q)); }
    else {
      c.fillText(chars[0], this.X(x + q), this.Y(y + q)); c.fillText(chars[1], this.X(x + q), this.Y(y - q));
      c.fillText(chars[2], this.X(x - q), this.Y(y + q)); if (chars[3]) c.fillText(chars[3], this.X(x - q), this.Y(y - q));
    }
    c.restore();
  }
  // 祥云：两三个回卷的云头，拖一条云尾（纸片只留细边）
  cloud(cx, cy, s = 0.1, w = 0.005, o = {}) {
    const heads = [[-0.45, 0.02, 0.3, 1], [0.05, 0.12, 0.38, -1], [0.52, -0.02, 0.26, 1]];
    const outline = [];
    // 外轮廓：沿云头上缘
    outline.push([-0.95, -0.12]);
    for (const [hx, hy, hr] of heads) for (let k = 0; k <= 8; k++) { const a = Math.PI * (1 - k / 8); outline.push([hx + Math.cos(a) * hr, hy + Math.sin(a) * hr]); }
    outline.push([0.85, -0.12], [0.3, -0.24], [-0.3, -0.22]);
    const P = (pts) => pts.map(([x, y]) => [cx + x * s, cy + y * s]);
    this.fill(P(outline), o.fill || PAPER);
    if (o.wash) this.wash(P(outline), o.wash, o.washA || 0.3);
    for (const [hx, hy, hr, d] of heads) {
      const sp = [];
      for (let k = 0; k <= 30; k++) { const t = k / 30, a = Math.PI * (d > 0 ? 1 - 2.1 * t : 2.1 * t) , r = hr * (1 - 0.78 * t); sp.push([hx + Math.cos(a) * r * d * -1 * -1, hy + Math.sin(a) * r]); }
      this.stroke(P(sp), w, { taper: [0.05, 0.4] });
    }
    // 云尾
    this.stroke(P([[0.75, -0.08], [1.1, -0.18], [1.45, -0.12], [1.7, -0.2]]), w * 0.8, { taper: [0.1, 0.6] });
    this.stroke(P([[-0.9, -0.12], [-0.2, -0.2], [0.5, -0.16]]), w * 0.6, { alpha: 0.8 });
  }
  // 波浪线
  waves(x0, x1, y, amp = 0.012, wl = 0.07, w = 0.004, o = {}) {
    const pts = [];
    for (let x = x0; x <= x1 + 1e-6; x += wl / 8) pts.push([x, y + Math.sin((x - x0) / wl * Math.PI * 2) * amp]);
    this.stroke(pts, w, { smooth: false, ...o });
  }
}
