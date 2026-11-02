// 庄子 · 互动书 —— 主程序
import * as THREE from 'three';
import { createStage } from './stage.js';
import { Book, makeTextures, W, H, T, TB, OV } from './book.js';
import { buildPages, drawBase, drawLive, tocHit, storyHit, markHit, cnNum, PW, PH, PAGE_FONTS_TEXT } from './pages.js';
import { Popup } from './popup.js';
import { SCENES } from './scenes/index.js';
import { FONTS } from './ink.js';
import { clamp, easeInOut, lerp, isTouch, reduceMotion } from './util.js';
import * as sfx from './audio.js';

const STORE = 'zhuangzi-book:v2';
const HINTED = 'zhuangzi-book:hinted';
// 插图页自动演示：页面立起来后，每隔一段时间依次“点亮”图中的一样东西并写出批注
const AUTO_FIRST = 3.0, AUTO_GAP = 6.5;
// 截图调试：?dt=0.5 允许更大的帧间隔（软件渲染时动画不至于太慢）
const DTMAX = +(new URLSearchParams(location.search).get('dt') || 0.05);
const $ = (s) => document.querySelector(s);

// —— 字体：网络字体可用就用，加载不到就用系统宋体/楷体 ——
const fontReady = new Set();
async function ensureFonts(text) {
  if (!document.fonts || !text) return false;
  const specs = [
    `40px "GJ-Kai"`, `700 40px "GJ-Kai"`,
    `40px "GJ-KaiFallback"`, `40px "GJ-KaiExtB"`, `40px "GJ-KaiPua"`,
    `40px "GJ-Song"`, `700 40px "GJ-Song"`,
    `40px "GJ-Title"`, `600 40px "GJ-Title"`,
    `40px "Ma Shan Zheng"`, `40px "Noto Serif SC"`,
  ];
  const need = specs.filter(s => !document.fonts.check(s, text));
  if (!need.length) return false;
  try {
    await Promise.race([Promise.all(need.map(s => document.fonts.load(s, text))), new Promise(r => setTimeout(r, 3500))]);
  } catch (e) { /* 忽略 */ }
  return true;
}

async function boot() {
  const mobile = isTouch() || Math.min(innerWidth, innerHeight) < 600;
  const [mainRes, originRes, marksRes] = await Promise.all([
    fetch('content/zhuangzi.json'),
    fetch('content/original.json').catch(() => null),
    fetch('content/marks.json').catch(() => null),
  ]);
  const data = await mainRes.json();
  const original = originRes && originRes.ok ? await originRes.json() : null;
  const marks = marksRes && marksRes.ok ? await marksRes.json() : null;
  await ensureFonts('庄子内外杂篇三十三互动读本原文白话南华真经逍遥战国周及其后学简体全文关于这本书导读目录记号说明概念人物地名古今异义关键词' + data.map(c => c.title).join(''));

  const stage = createStage($('#gl'), { mobile });
  const { renderer, scene, camera } = stage;
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const tex = makeTextures(FONTS);
  const book = new Book(tex);
  book.group.position.set(0, 0, 0);
  scene.add(book.group);

  const { pages, chapterPage, tocPage } = buildPages(data, original, marks);
  for (const p of pages) if (p.scene && SCENES[p.scene]) p.ground = SCENES[p.scene].ground;
  const N = pages.length / 2;           // 纸张数
  const hR = (m) => m <= 0 ? T : Math.max(0, T * (N - (m - 1)) / N);
  const hL = (m) => m <= 1 ? 0 : T * (m - 1) / N;

  // —— 左侧目录边栏 ——
  const sidebar = $('#sidebar'), sideList = $('#side-list'), menuBtn = $('#menu');
  const sideButtons = [];
  function setSidebar(open) {
    sidebar.classList.toggle('open', open);
    sidebar.setAttribute('aria-hidden', open ? 'false' : 'true');
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) sfx.tap(540, 0.12, 0.06);
  }
  menuBtn.addEventListener('click', () => setSidebar(!sidebar.classList.contains('open')));
  $('#side-close').addEventListener('click', () => setSidebar(false));
  document.addEventListener('pointerdown', (e) => {
    if (!sidebar.classList.contains('open')) return;
    if (!sidebar.contains(e.target) && !menuBtn.contains(e.target)) setSidebar(false);
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') setSidebar(false); });
  let sidePart = '';
  for (const ch of data) {
    if (ch.part !== sidePart) {
      sidePart = ch.part;
      const h = document.createElement('p'); h.className = 'side-part'; h.textContent = ch.part; sideList.appendChild(h);
    }
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.no = ch.no;
    const n = document.createElement('small'); n.textContent = cnNum(+ch.no); b.appendChild(n);
    b.appendChild(document.createTextNode(ch.title));
    b.addEventListener('click', () => {
      const page = chapterPage[+ch.no];
      if (page == null) return;
      const t = spreadOf(page + 1);
      jumpTo(t.m, t.side);
      setSidebar(false);
    });
    sideList.appendChild(b); sideButtons.push(b);
  }

  // —— 书页纹理缓存 ——
  const cache = new Map();   // index -> {canvas, base, tex, live, used}
  const live = new Map();    // index -> 动态状态（批注、已发现的条目……）
  let clock = 0;
  let warmTimer = 0;         // 空闲时预热相邻对开页纹理
  function liveOf(i) { if (!live.has(i)) live.set(i, { t: 0, t0: 0, found: new Set(), note: null, hover: null, active: false }); return live.get(i); }
  function entry(i) {
    let e = cache.get(i);
    if (!e) {
      const page = pages[i];
      const pix = 1;
      const base = document.createElement('canvas'); base.width = PW * pix; base.height = PH * pix;
      const canvas = document.createElement('canvas'); canvas.width = PW * pix; canvas.height = PH * pix;
      const t = new THREE.CanvasTexture(canvas);
      t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso;
      t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
      e = { canvas, base, tex: t, used: clock, pix };
      cache.set(i, e);
      paintBase(i, e);
      const txt = PAGE_FONTS_TEXT(page);
      if (txt) ensureFonts(txt).then(changed => { if (changed && cache.get(i) === e) { paintBase(i, e); } });
      evict();
    }
    e.used = clock;
    return e;
  }
  function paintBase(i, e) {
    const g = e.base.getContext('2d');
    g.setTransform(e.pix, 0, 0, e.pix, 0, 0);
    drawBase(g, pages[i], { pages });
    composite(i, e);
  }
  function composite(i, e) {
    const g = e.canvas.getContext('2d');
    g.setTransform(e.pix, 0, 0, e.pix, 0, 0);
    g.clearRect(0, 0, PW, PH);
    g.drawImage(e.base, 0, 0, PW, PH);
    const L = live.get(i);
    let busy = false;
    if (L && L.active) busy = drawLive(g, pages[i], L, { pages });
    e.tex.needsUpdate = true;
    dirty = true;
    return busy;
  }
  function evict() {
    if (cache.size <= 16) return;
    const vis = new Set(visibleIndices());
    const arr = [...cache.entries()].filter(([i]) => !vis.has(i)).sort((a, b) => a[1].used - b[1].used);
    while (cache.size > 12 && arr.length) { const [i, e] = arr.shift(); e.tex.dispose(); cache.delete(i); }
  }
  const pageTex = (i) => (i >= 0 && i < pages.length) ? entry(i).tex : null;

  // —— 状态 ——
  let dirty = true;            // 下一帧需要重画（静止时不重画，画面不会有任何抖动）
  let pos = 0;                 // 0：合上；m≥1：已翻过 m 张（含封面）
  let focus = 'R';             // 单页模式下看哪一边
  let zoom = false;            // 宽屏下双击放大单页
  const narrow = () => camera.aspect < 0.9;
  const single = () => narrow() || zoom;
  const leftIdx = (m) => m >= 2 ? 2 * m - 3 : -1;
  const rightIdx = (m) => (m >= 0 && m <= N) ? 2 * Math.max(0, m - 1) : -1;
  function visibleIndices() { return [leftIdx(pos), rightIdx(pos)].filter(i => i >= 0); }

  // 静止页面
  function applyStatic(m, { rightM = m, leftM = m } = {}) {
    const ri = rightIdx(rightM), li = leftIdx(leftM);
    book.pageR.group.visible = ri >= 0 && rightM >= 0;
    if (ri >= 0) { book.pageR.setMaps(pageTex(ri), null); book.pageR.shape(0, hR(rightM), 0); }
    book.pageL.group.visible = li >= 0;
    if (li >= 0) { book.pageL.setMaps(null, pageTex(li)); book.pageL.shape(1, 0, hL(leftM)); }
    book.setHeights(hR(rightM), hL(leftM));
    dirty = true;
  }

  // —— 翻页 ——
  let flip = null;      // 当前翻动 {dir, t, from, to, leaf, mode, ...}
  let coverAnim = null; // 封面开合
  let riffle = null;    // 快速翻到远处
  const queue = [];

  function bendFor(t, mode, dir) {
    // 用手拖时页角领先；自动翻时先掀起、过了中线后外缘下垂
    const s = Math.sin(Math.PI * t);
    const b = mode === 'drag' ? 0.95 * s * (1.1 - t) : 0.75 * s * Math.cos(Math.PI * t * 1.05 + 0.15) + 0.18 * s;
    return dir > 0 ? b : -(mode === 'drag' ? 0.95 * s * (0.1 + t) : 0.75 * s * Math.cos(Math.PI * (1 - t) * 1.05 + 0.15) + 0.18 * s);
  }

  function startFlip(dir, mode = 'auto', grabV = 0.75) {
    if (flip || coverAnim || riffle) return false;
    if (dir > 0 && pos >= N + 1) return false;
    if (dir < 0 && pos <= 0) return false;
    if ((dir > 0 && pos === 0) || (dir < 0 && pos === 1)) {
      // 封面
      if (mode === 'drag') return false;
      closePopup();
      coverAnim = { dir, t: 0, from: book.coverOpen, to: dir > 0 ? 1 : 0 };
      sfx.cover();
      if (dir > 0) { pos = 1; applyStatic(1); }
      return true;
    }
    closePopup(mode === 'drag');
    const m = pos;
    const leaf = book.getLeaf();
    let front, back, hFrom, hTo;
    if (dir > 0) {
      front = pageTex(2 * m - 2); back = pageTex(2 * m - 1);
      applyStatic(m, { rightM: m + 1, leftM: m });
      hFrom = hR(m) + 0.0015; hTo = hL(m + 1) + 0.0008;
    } else {
      front = pageTex(2 * m - 4); back = pageTex(2 * m - 3);
      applyStatic(m, { rightM: m, leftM: m - 1 });
      hFrom = hR(m - 1) + 0.0008; hTo = hL(m) + 0.0015;
    }
    leaf.setMaps(front, back);
    flip = { dir, t: dir > 0 ? 0 : 1, start: dir > 0 ? 0 : 1, target: dir > 0 ? 1 : 0, mode, leaf, m, hFrom, hTo, twist: (grabV - 0.5) * 1.2, v: 0, released: mode !== 'drag', played: false };
    shapeFlip();
    if (mode !== 'drag') { sfx.flip(); flip.played = true; }
    return true;
  }

  function shapeFlip() {
    const f = flip;
    const b = bendFor(f.dir > 0 ? f.t : f.t, f.mode, f.dir);
    f.leaf.shape(f.t, f.hFrom, f.hTo, f.dir > 0 ? b : b, f.twist * Math.sin(Math.PI * f.t));
  }

  function endFlip(done) {
    const f = flip;
    book.releaseLeaf(f.leaf);
    flip = null;
    if (done) pos = f.dir > 0 ? f.m + 1 : f.m - 1;
    applyStatic(pos);
    settle();
    if (queue.length) { const d = queue.shift(); go(d); }
  }

  // 一次走一步（前/后）
  function go(dir) {
    hideMarkCard();
    if (flip || coverAnim || riffle) { if (queue.length < 2) queue.push(dir); else if (flip && flip.released) flip.speed = 2.2; return; }
    if (single()) {
      // 单页模式：先在左右页之间移动镜头
      if (dir > 0 && focus === 'L' && pos >= 1 && rightIdx(pos) >= 0) { focusRight(); return; }
      if (dir < 0 && focus === 'R' && leftIdx(pos) >= 0) { focusLeft(); return; }
    }
    if (startFlip(dir)) {
      // 双页时以左页为准（读的顺序先左后右），单页时停在翻过来的那一面
      focus = single() ? (dir > 0 ? 'L' : 'R') : 'L';
      reframe();
    }
    dismissHint();
  }

  // 单页模式下镜头移到右页：插图从头再立起来一次
  function focusRight() {
    hideMarkCard();
    focus = 'R'; reframe(); onSpreadUI(); updateHash();
    if (popup && popup.T > 0.5) { popup.T = -0.25; for (const it of popup.items) it.popped = false; popup.popped = 0; }
    if (popup && popup.auto) popup.auto.at = AUTO_FIRST;
  }
  function focusLeft() { hideMarkCard(); focus = 'L'; reframe(); onSpreadUI(); updateHash(); }

  // 快速翻到第 m 张；side 指定落在哪一面（单页模式、地址栏用）
  function jumpTo(m, side) {
    hideMarkCard();
    m = clamp(Math.round(m), 0, N + 1);
    if (flip || coverAnim || riffle) return;
    dismissHint();
    if (m === pos) {
      if (side && side !== focus) { if (side === 'R') focusRight(); else focusLeft(); }
      return;
    }
    const dir = m > pos ? 1 : -1;
    const land = () => { focus = side || (single() ? (dir > 0 ? 'L' : 'R') : 'L'); reframe(); };
    if (pos === 0 && m > 1) {
      // 先开封面，再翻
      startFlip(1); pendingJump = { m, side }; return;
    }
    if (m === 0) { if (pos === 1) go(-1); else { pendingJump = { m: 0 }; jumpTo(1); } return; }
    if (Math.abs(m - pos) === 1 || pos === 0) { if (startFlip(dir)) land(); return; }
    closePopup();
    land();
    const k = Math.min(7, Math.abs(m - pos));
    const generic = pageTex(chapterPage[1] + 2);
    const leaves = [];
    // 第一张显示当前页，最后一张显示目标页，中间几张一闪而过
    for (let i = 0; i < k; i++) {
      const l = book.getLeaf();
      let front = generic, back = generic;
      if (dir > 0) {
        if (i === 0) front = pageTex(rightIdx(pos));
        if (i === k - 1) back = pageTex(leftIdx(m));
      } else {
        if (i === 0) back = pageTex(leftIdx(pos));
        if (i === k - 1) front = pageTex(rightIdx(m));
      }
      l.setMaps(front || generic, back || generic);
      l.group.visible = false;
      leaves.push(l);
    }
    riffle = { dir, from: pos, to: m, k, t: 0, leaves };
    // 目标页先就位
    if (dir > 0) applyStatic(pos, { rightM: m, leftM: pos });
    else applyStatic(pos, { rightM: pos, leftM: m });
    sfx.flip(2.2);
  }
  let pendingJump = null;

  function updateRiffle(dt) {
    const r = riffle;
    r.t += dt;
    const per = 0.42, gap = 0.085;
    let done = true;
    const { dir, from, to } = r;
    r.leaves.forEach((l, i) => {
      const p = clamp((r.t - i * gap) / per);
      if (p < 1) done = false;
      l.group.visible = p > 0 && p < 1;
      const e = easeInOut(p);
      const t = dir > 0 ? e : 1 - e;
      const hA = dir > 0 ? hR(to) + 0.0015 * (r.k - i) : hR(from) + 0.001;
      const hB = dir > 0 ? hL(from) + 0.001 : hL(to) + 0.0015 * (r.k - i);
      l.shape(t, hA, hB, bendFor(t, 'auto', dir), 0.2 * Math.sin(Math.PI * t));
    });
    if (Math.floor(r.t / 0.16) !== Math.floor((r.t - dt) / 0.16) && r.t < r.k * gap) sfx.flip(3);
    if (done) {
      r.leaves.forEach(l => book.releaseLeaf(l));
      riffle = null;
      pos = to;
      applyStatic(pos);
      settle();
    }
  }

  // —— 立体插图 ——
  let popup = null;
  function closePopup(follow = false) {
    if (!popup) return;
    const p = popup;
    popup = null;
    p.close();
    p.follow = follow;
    dying.push(p);
  }
  const dying = [];
  function openPopup() {
    if (pos === 0) {
      popup = new Popup(SCENES.cover, { renderer, aniso });
      popup.root.position.set(0, TB + 0.001, 0);
      popup.T = 0; popup.closeRate = 1.1;
      book.coverHinge.add(popup.root);
      return;
    }
    const ri = rightIdx(pos);
    if (ri < 0 || pos < 1) return;
    const page = pages[ri];
    if (!page.scene || !SCENES[page.scene]) return;
    const L = liveOf(ri);
    popup = new Popup(SCENES[page.scene], {
      renderer, aniso,
      onNote: (key, auto) => {
        if (!page.meta || !page.meta.notes || !page.meta.notes[key]) return;
        L.found.add(key); L.note = { key, t0: L.t }; L.active = true; L.busy = true;
        sfx.brush();
        if (!auto && single() && focus !== 'R') focusRight();
      },
    });
    popup.page = ri;
    const keys = Object.keys((page.meta && page.meta.notes) || {}).filter(k => popup.hotKeys().includes(k));
    if (keys.length) popup.auto = { keys, i: 0, at: AUTO_FIRST };
    popup.root.position.set(W / 2, TB + hR(pos) + 0.0008, 0);
    popup.T = -0.35;
    book.group.add(popup.root);
  }

  // 停在一个对开页上
  function settle() {
    if (pos >= 1) localStorage.setItem(STORE, JSON.stringify({ pos, focus }));
    else localStorage.setItem(STORE, JSON.stringify({ pos: 0 }));
    for (const i of visibleIndices()) {
      const L = liveOf(i);
      const page = pages[i];
      if (page.type === 'text' || page.type === 'origin' || page.type === 'toc' || page.type === 'scenepage') {
        L.active = true; L.t = 0; L.busy = true;
        if (page.type === 'text' && !page.lines.some(l => (l.sem && l.sem.length) || (l.marks && l.marks.length))) L.busy = false;
        if (page.type === 'origin' && !page.rows.some(r => r.sem && r.sem.length)) L.busy = false;
      }
    }
    openPopup();
    if (pendingJump != null) { const j = pendingJump; pendingJump = null; setTimeout(() => jumpTo(j.m, j.side), 60); }
    if (leftIdx(pos) < 0) focus = 'R';
    if (rightIdx(pos) < 0) focus = 'L';
    reframe();
    onSpreadUI();
    updateHash();
    prewarmNext();
  }

  // 空闲时预生成前后对开页纹理：翻页时不再临时 paint/上传，避免掉帧与声音卡顿
  function prewarmNext() {
    clearTimeout(warmTimer);
    warmTimer = setTimeout(() => {
      if (flip || riffle || coverAnim || drag) return;
      const want = [];
      for (const m of [pos + 1, pos - 1]) {
        if (m < 1) continue;
        for (const i of [leftIdx(m), rightIdx(m)]) {
          if (i >= 0 && i < pages.length && !cache.has(i) && !want.includes(i)) want.push(i);
        }
      }
      const step = () => {
        if (flip || riffle || coverAnim || drag) return;
        const i = want.shift();
        if (i == null) return;
        entry(i);
        if (window.requestIdleCallback) window.requestIdleCallback(step, { timeout: 260 });
        else setTimeout(step, 60);
      };
      step();
    }, 180);
  }

  // 当前所指的那一页（0 起）：单页时是正在看的那面；双页时是 focus 一侧（翻页后为左页）
  function curIdx() {
    if (pos < 1) return -1;
    return focus === 'L' && leftIdx(pos) >= 0 ? leftIdx(pos) : (rightIdx(pos) >= 0 ? rightIdx(pos) : leftIdx(pos));
  }
  // 地址栏里的 #p=N 与书页上印的页码一致（N = 下标 + 1）
  function updateHash() {
    const i = curIdx();
    const url = i >= 0 ? `#p=${i + 1}` : location.pathname + location.search;
    if ((i >= 0 ? location.hash : '') !== (i >= 0 ? url : '')) history.replaceState(null, '', url);
  }
  // 第 n 页（1 起）在第几张、哪一面
  function spreadOf(n) {
    const i = clamp(n - 1, 0, pages.length - 1);
    return { m: i % 2 === 0 ? i / 2 + 1 : (i + 3) / 2, side: i % 2 === 0 ? 'R' : 'L' };
  }

  // —— 镜头 ——
  function reframe(snap = false) {
    const el = narrow() ? 1.12 : 1.0;
    if (pos === 0 && !coverAnim) {
      stage.frame((W + OV) / 2, 0.02, W + 0.32, H + 0.34, { el: 1.05, snap, pad: narrow() ? 1.04 : 1.12 });
    } else if (single()) {
      const x = focus === 'L' ? -W / 2 : W / 2;
      stage.frame(x * 0.98, 0, W + (narrow() ? 0.1 : 0.16), H + 0.1, { el, snap, pad: 1.02 });
    } else {
      stage.frame(0, 0.0, 2 * W + 0.3, H + 0.24, { el, snap, pad: 1.04 });
    }
  }

  // —— 界面 ——
  const label = $('#label'), sub = $('#sub');
  const markcard = $('#markcard'), mkCat = $('#mk-cat'), mkTitle = $('#mk-title'), mkBody = $('#mk-body'), mkExtra = $('#mk-extra');
  const MK_CAT = { concept: '概念 · 术语词典', person: '人物 · 人物志', place: '地名', classical: '古今异义', keyword: '关键词' };
  function hideMarkCard() { markcard.hidden = true; markcard.classList.remove('on'); }
  function showMarkCard(m, x, y) {
    if (!m || !m.info) { hideMarkCard(); return; }
    mkCat.textContent = MK_CAT[m.cat] || '记号';
    mkTitle.textContent = m.t;
    mkBody.textContent = m.info;
    mkExtra.textContent = m.portrait || '';
    markcard.hidden = false;
    requestAnimationFrame(() => {
      markcard.classList.add('on');
      const pad = 14;
      const w = markcard.offsetWidth, h = markcard.offsetHeight;
      let left = x + 18, top = y + 18;
      if (left + w > innerWidth - pad) left = x - w - 18;
      if (top + h > innerHeight - pad) top = y - h - 18;
      markcard.style.left = clamp(left, pad, innerWidth - w - pad) + 'px';
      markcard.style.top = clamp(top, pad, innerHeight - h - pad) + 'px';
    });
  }
  $('#mk-close').addEventListener('click', hideMarkCard);
  document.addEventListener('pointerdown', (e) => { if (!markcard.contains(e.target)) hideMarkCard(); }, true);
  function chapterAt(i) {
    for (let k = i; k >= 0; k--) if (pages[k].ch) return pages[k].ch;
    return null;
  }
  function onSpreadUI() {
    let t = '封面', s = '', activeNo = 0;
    if (pos >= 1) {
      const i = single() ? curIdx() : (rightIdx(pos) >= 0 ? rightIdx(pos) : leftIdx(pos));
      const page = pages[i] || pages[leftIdx(pos)];
      const ch = page && page.type !== 'after' && page.type !== 'colophon' && page.scene !== 'end' ? chapterAt(page.index) : null;
      if (ch) activeNo = +ch.no;
      if (page && page.type === 'origin') { t = ch ? ch.title : '原文'; s = '原文'; }
      else if (ch) { t = ch.title; s = ch.part; }
      else if (page && page.type === 'toc') t = '目录';
      else if (page && (page.type === 'intro1' || page.type === 'intro2' || page.scene === 'parts')) t = '导读';
      else if (page && page.type === 'legend') { t = '记号说明'; s = '导读'; }
      else if (page && page.index < 3) t = '扉页';
      else t = '读后';
      const li = leftIdx(pos), ri = rightIdx(pos);
      if ((li >= 0 && pages[li] && pages[li].type === 'legend') || (ri >= 0 && pages[ri] && pages[ri].type === 'legend')) { t = '记号说明'; s = '导读'; }
      const nums = !single() && li >= 0 && ri >= 0 ? `${li + 1}–${ri + 1}` : `${curIdx() + 1}`;
      s = (s ? s + ' · ' : '') + `第 ${nums} 页 / ${pages.length}`;
    }
    label.textContent = t; sub.textContent = s;
    for (const b of sideButtons) b.classList.toggle('on', +b.dataset.no === activeNo);
    $('#prev').disabled = pos === 0;
    $('#next').disabled = pos >= N + 1;
  }

  // —— 一次性提示 ——
  const hintEl = $('#hint');
  let hintTimer = 0;
  function showHint() {
    let seen = false;
    try { seen = !!localStorage.getItem(HINTED); } catch (_) { /* */ }
    if (seen) return;
    hintEl.textContent = isTouch() ? '左右或上下滑动翻页，轻点两侧也行' : '滚动滚轮、按方向键或点击两侧翻页';
    hintEl.classList.add('show');
    hintTimer = setTimeout(dismissHint, 7000);
  }
  function dismissHint() {
    if (!hintEl.classList.contains('show')) return;
    hintEl.classList.remove('show');
    clearTimeout(hintTimer);
    try { localStorage.setItem(HINTED, '1'); } catch (_) { /* */ }
  }
  $('#prev').addEventListener('click', () => { sfx.unlock(); go(-1); });
  $('#next').addEventListener('click', () => { sfx.unlock(); go(1); });
  const muteBtn = $('#mute');
  const setMuteUI = () => { muteBtn.classList.toggle('off', sfx.isMuted()); muteBtn.setAttribute('aria-label', sfx.isMuted() ? '打开声音' : '静音'); };
  muteBtn.addEventListener('click', () => { sfx.unlock(); sfx.setMuted(!sfx.isMuted()); setMuteUI(); });
  setMuteUI();
  addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    let dir = 0;
    if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || (k === ' ' && !e.shiftKey) || k === 'Enter') dir = 1;
    else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || (k === ' ' && e.shiftKey) || k === 'Backspace') dir = -1;
    if (dir) {
      // 焦点在按钮上时 Enter/空格 交给按钮本身
      if ((k === 'Enter' || k === ' ') && e.target && e.target.closest && e.target.closest('button')) return;
      e.preventDefault(); sfx.unlock(); go(dir);
    } else if (k === 'Home') { e.preventDefault(); jumpTo(0); }
    else if (k === 'End') { e.preventDefault(); jumpTo(N + 1); }
  });

  // —— 滚轮 / 触控板：一次手势只翻一页 ——
  // 手势在停顿 220ms 后才算结束（触控板的惯性滚动会持续很久，不能算成多次）；
  // 惯性衰减中突然又变大，说明是新的一次滑动。时间用事件自带的时间戳，主线程忙时也不会误判
  const wheel = { acc: 0, lock: false, last: -1e9, mag: 0, at: -1e9 };
  addEventListener('wheel', (e) => {
    if (e.ctrlKey) return;               // 触控板捏合缩放
    e.preventDefault();
    const now = e.timeStamp || performance.now();
    const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? innerHeight : 1;
    const dx = e.deltaX * unit, dy = e.deltaY * unit;
    const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
    const mag = Math.abs(d);
    const gap = now - wheel.last;
    wheel.last = now;
    if (wheel.lock && now - wheel.at > 350 && (gap > 220 || (mag > 12 && mag > wheel.mag * 2.2 && gap > 40))) wheel.lock = false;
    wheel.mag = mag;
    if (wheel.lock) return;
    if (gap > 220) wheel.acc = 0;
    wheel.acc += d;
    if (Math.abs(wheel.acc) >= 24) {
      sfx.unlock();
      go(wheel.acc > 0 ? 1 : -1);
      wheel.acc = 0; wheel.lock = true; wheel.at = now;
    }
  }, { passive: false });

  // 手动改地址栏里的 #p=N 也能跳过去
  addEventListener('hashchange', () => {
    const hm = location.hash.match(/p=(\d+)/);
    if (!hm) return;
    const { m, side } = spreadOf(+hm[1]);
    if (flip || coverAnim || riffle) pendingJump = { m, side };
    else jumpTo(m, side);
  });

  // —— 指针：拖动翻页、点击插图、目录 ——
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function setRay(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  }
  function pageHit() {
    const objs = [];
    if (book.pageR.group.visible) objs.push(book.pageR.front);
    if (book.pageL.group.visible) objs.push(book.pageL.back);
    const h = ray.intersectObjects(objs, false)[0];
    if (!h) return null;
    const side = h.object === book.pageR.front ? 'R' : 'L';
    return { side, uv: h.uv, index: side === 'R' ? rightIdx(pos) : leftIdx(pos), point: h.point };
  }
  function coverHit() { return ray.intersectObject(book.cover, false)[0] || ray.intersectObject(book.blockR, false)[0]; }
  // 书页宽度在屏幕上有多少像素
  function pagePixels() {
    const a = new THREE.Vector3(0, TB, 0).applyMatrix4(book.group.matrixWorld).project(camera);
    const b = new THREE.Vector3(W, TB, 0).applyMatrix4(book.group.matrixWorld).project(camera);
    return Math.max(80, Math.abs(b.x - a.x) * innerWidth / 2);
  }

  // 书脊在屏幕上的横坐标：点在它左边往回翻，右边往后翻
  function spineX() {
    if (single()) return innerWidth / 2;
    const v = new THREE.Vector3(0, TB, 0).applyMatrix4(book.group.matrixWorld).project(camera);
    return (v.x + 1) / 2 * innerWidth;
  }

  // 拖动书页翻（跟手），或者轻扫、轻点左右两半
  let drag = null;
  const el = renderer.domElement;
  el.addEventListener('pointerdown', (e) => {
    sfx.unlock();
    setRay(e);
    drag = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, type: e.pointerType, moved: false, flipping: false, hit: null };
    // 插图里的小机关只给鼠标用；手指点哪里都是翻页
    if (popup && e.pointerType === 'mouse') { const k = popup.pick(ray); if (k) drag.hot = k; }
    drag.hit = pageHit();
    try { el.setPointerCapture(e.pointerId); } catch (_) { /* */ }
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) { hover(e); return; }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 10) {
      drag.moved = true;
      drag.hot = null;
      // 横向拖动：书页跟着手指走
      if (Math.abs(dx) > Math.abs(dy) * 0.8 && !flip && !coverAnim && !riffle) {
        const dir = dx < 0 ? 1 : -1;
        dismissHint();
        if (single() && dir > 0 && focus === 'L' && rightIdx(pos) >= 0 && pos >= 1) { focusRight(); drag.done = true; return; }
        if (single() && dir < 0 && focus === 'R' && leftIdx(pos) >= 0) { focusLeft(); drag.done = true; return; }
        if (pos === 0 || (dir < 0 && pos === 1)) { go(dir); drag.done = true; return; }
        const grabV = drag.hit ? 1 - drag.hit.uv.y : 0.75;
        if (startFlip(dir, 'drag', grabV)) { drag.flipping = true; drag.dir = dir; drag.px = pagePixels(); }
      }
    }
    if (drag.flipping && flip) {
      const p = clamp(-dx * drag.dir / (drag.px * 1.7));
      const now = performance.now();
      const nt = drag.dir > 0 ? p : 1 - p;
      flip.v = (nt - flip.t) / Math.max(1, now - (drag.lt || now - 16)) * 1000;
      drag.lt = now;
      flip.t = nt;
      shapeFlip();
      if (!flip.played && p > 0.06) { sfx.flip(1.2); flip.played = true; }
    }
  });
  const up = (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    if (e.type === 'pointercancel' && !d.flipping) return;
    if (d.flipping && flip) {
      const prog = d.dir > 0 ? flip.t : 1 - flip.t;
      const vel = flip.v * d.dir;
      const complete = prog > 0.3 || vel > 1.0;
      flip.target = complete ? (d.dir > 0 ? 1 : 0) : (d.dir > 0 ? 0 : 1);
      flip.released = true; flip.mode = 'auto'; flip.cancel = !complete;
      flip.rel = { t0: flip.t, k: 0 };
      if (complete) focus = single() ? (d.dir > 0 ? 'L' : 'R') : 'L';
      return;
    }
    if (d.done) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (d.moved) {
      // 轻扫（含上下滑）：上滑/左滑往后，下滑/右滑往前
      if (Math.hypot(dx, dy) < 30) return;
      go(Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 1 : -1) : (dy < 0 ? 1 : -1));
      return;
    }
    // 轻点
    if (d.hot && popup) {
      popup.hit(d.hot);
      if (popup.auto) popup.auto.at = popup.T + AUTO_GAP * 1.5;
      return;
    }
    setRay(e);
    if (pos === 0) { go(1); return; }
    const ph = pageHit();
    const page = ph && pages[ph.index];
    if (page) {
      const mh = markHit(page, ph.uv.x, ph.uv.y);
      if (mh && mh.info) { sfx.tap(620, 0.24, 0.1); showMarkCard(mh, e.clientX, e.clientY); return; }
    }
    if (page && page.type === 'toc') {
      const no = tocHit(page, ph.uv.x, ph.uv.y);
      if (no) { sfx.tap(660, 0.2, 0.12); jumpTo(Math.floor(chapterPage[no] / 2) + 2, 'L'); return; }
    }
    if (page && page.type === 'opener') {
      const pi = storyHit(page, ph.uv.x, ph.uv.y);
      if (pi != null) { sfx.tap(660, 0.2, 0.12); const t = spreadOf(pi + 1); jumpTo(t.m, t.side); return; }
    }
    go(e.clientX < spineX() ? -1 : 1);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);

  let hoverKey = null, tocHover = null;
  function hover(e) {
    if (e.pointerType !== 'mouse') return;
    setRay(e);
    const k = popup ? popup.pick(ray) : null;
    if (k !== hoverKey) { hoverKey = k; popup && popup.setHover(k); }
    let th = null, link = !!k;
    if (!k && pos === 0) coverTease = coverHit() ? 1 : 0;
    else coverTease = 0;
    if (!k && pos >= 1) {
      const ph = pageHit();
      if (ph) {
        const page = pages[ph.index];
        if (page.type === 'toc') { th = tocHit(page, ph.uv.x, ph.uv.y); if (th) { link = true; th = { i: ph.index, no: th }; } }
        if (page.type === 'opener' && storyHit(page, ph.uv.x, ph.uv.y) != null) link = true;
        if (markHit(page, ph.uv.x, ph.uv.y)?.info) link = true;
      }
    }
    if ((th && th.no) !== (tocHover && tocHover.no)) {
      if (tocHover) { const L = liveOf(tocHover.i); L.hover = null; L.busy = true; }
      if (th) { const L = liveOf(th.i); L.hover = th.no; L.busy = true; L.active = true; }
      tocHover = th;
    }
    // 链接处是手指；其余地方提示往哪边翻
    el.style.cursor = link ? 'pointer' : pos === 0 ? 'pointer' : (e.clientX < spineX() ? (pos > 0 ? 'w-resize' : '') : (pos < N + 1 ? 'e-resize' : ''));
  }
  let coverTease = 0, teaseV = 0;

  // —— 恢复阅读位置 ——
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (_) { /* */ }
  const hm = location.hash.match(/p=(\d+)/);
  if (hm) {
    const t = spreadOf(+hm[1]);
    pos = t.m; focus = t.side;
  } else if (saved && saved.pos >= 1) { pos = clamp(saved.pos, 1, N + 1); focus = saved.focus || 'R'; }
  book.setCover(pos >= 1 ? 1 : 0);
  applyStatic(pos);
  reframe(true);
  settle();
  onSpreadUI();

  addEventListener('resize', () => { stage.resize(); reframe(); onSpreadUI(); dirty = true; });

  // —— 渲染循环 ——
  const timer = new THREE.Clock();
  $('#loading').classList.add('done');
  document.body.classList.add('ready');
  setTimeout(showHint, 900);
  const reduce = reduceMotion();
  let liveDt = 0;

  function frame() {
    const dt = Math.min(DTMAX, timer.getDelta());
    clock += dt;

    // 封面
    if (coverAnim) {
      coverAnim.t += dt / (reduce ? 0.3 : 1.25);
      const e = easeInOut(coverAnim.t);
      book.setCover(lerp(coverAnim.from, coverAnim.to, e));
      if (coverAnim.t >= 1) {
        const dir = coverAnim.dir;
        coverAnim = null;
        pos = dir > 0 ? 1 : 0;
        applyStatic(pos);
        settle();
      } else if (coverAnim.t > 0.15) reframe();
    } else if (pos === 0) {
      // 鼠标停在封面上时微微掀起；其余时候完全静止（以前一直在“呼吸”，画面就一直在抖）
      const want = coverTease ? 0.05 : 0;
      if (teaseV !== want) {
        teaseV = Math.abs(teaseV - want) < 1e-4 ? want : lerp(teaseV, want, 1 - Math.exp(-6 * dt));
        book.setCover(teaseV);
        dirty = true;
      }
    }

    // 翻页
    if (flip && flip.released) {
      const sp = (flip.speed || 1) * (reduce ? 3 : 1);
      if (!flip.rel) flip.rel = { t0: flip.t, k: 0 };
      flip.rel.k = Math.min(1, flip.rel.k + dt * sp / (flip.cancel ? 0.45 : (flip.mode === 'auto' && flip.rel.t0 === flip.start ? 0.95 : 0.6)));
      const e = flip.rel.t0 === flip.start ? easeInOut(flip.rel.k) : 1 - Math.pow(1 - flip.rel.k, 2.4);
      flip.t = lerp(flip.rel.t0, flip.target, e);
      shapeFlip();
      if (flip.rel.k >= 1) endFlip(!flip.cancel);
    }
    if (riffle) updateRiffle(dt);

    // 插图：自己演，不用点
    if (popup) {
      const a = popup.auto;
      if (a && !popup.closing && (!single() || focus === 'R') && popup.T >= a.at) {
        popup.hit(a.keys[a.i++ % a.keys.length], true);
        a.at = popup.T + AUTO_GAP;
      }
      popup.update(dt);
    }
    for (let i = dying.length - 1; i >= 0; i--) {
      const p = dying[i];
      if (p.follow && flip) p.F = Math.min(p.F, clamp(1 - Math.abs(flip.t - flip.start) * 6));
      p.update(dt);
      if (p.F <= 0) { p.dispose(); dying.splice(i, 1); }
    }

    // 页面动态层（批注写字等）：重画整页并上传纹理，30 次/秒就够了
    liveDt += dt;
    const liveTick = liveDt >= 1 / 30;
    for (const i of visibleIndices()) {
      const L = live.get(i);
      if (!L || !L.active) continue;
      L.t += dt;
      if (L.busy && liveTick) { const e = cache.get(i); if (e) L.busy = composite(i, e); }
    }
    if (liveTick) liveDt = 0;

    const camMoving = stage.updateCamera(dt);
    // 只有画面真的在变时才重画
    if (dirty || camMoving || coverAnim || flip || riffle || popup || dying.length || drag) {
      renderer.render(scene, camera);
      dirty = false;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // 调试/截图用
  window.__book = { stage, book, go, jumpTo, get pos() { return pos; }, get focus() { return focus; }, get busy() { return !!(flip || coverAnim || riffle || pendingJump); }, get popupT() { return popup && popup.T; }, get found() { return popup && popup.page != null ? [...liveOf(popup.page).found] : []; }, get flip() { return flip && { t: flip.t, mode: flip.mode, released: flip.released, h: [flip.hFrom, flip.hTo], vis: flip.leaf.group.visible, parent: !!flip.leaf.group.parent }; }, get drag() { return drag; }, N, pages, chapterPage, hit: (k) => popup && popup.hit(k), setZoom: (z, f) => { zoom = z; if (f) focus = f; reframe(true); onSpreadUI(); } };
}

boot().catch((e) => {
  console.error(e);
  const l = document.querySelector('#loading');
  l.textContent = '书没能打开：' + (e && e.message ? e.message : e);
});
