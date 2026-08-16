
"use strict";
/* =====================================================================
   Laser Dither Studio — single-file, offline image dithering for laser
   engraving. All classic error-diffusion algorithms are public domain.
   ===================================================================== */

const $ = id => document.getElementById(id);

/* ---------------- state ---------------- */
const state = {
  original: null,      // HTMLImageElement or canvas of the loaded file
  source: null,        // canvas after crop (what the pipeline consumes)
  aspect: 1,           // h/w of source
  cropMode: false,
  crop: null,          // {x,y,w,h} in original-image coords
  base: null,          // dither result before text {burn:Uint8Array, mask:Uint8Array, W, H}
  out: null,           // base + text stamped in — what preview/export consume
  texts: [],           // {text, font, size(mm), bold, italic, mode:'burn'|'blank', x, y(mm, centre), rot}
  selText: -1,
  textBoxes: [],       // per text: {x,y,w,h} in target px, for drag hit-testing
};

const params = {
  material: 'mdf', previewMat: true, materialLandscape: false, invert: false,
  wmm: 100, hmm: 100, lockAspect: true, dpi: 254,
  brightness: 0, contrast: 0, gamma: 1,
  usRadius: 0, usAmount: 0,
  algo: 'jarvis', zoom: 'fit', exportAlpha: false,
  boardOn: false, boardW: 300, boardH: 200, boardRound: false,
  posX: 0, posY: 0, boardPreview: false,
  engrave: false,
};

/* ---------------- pipeline ---------------- */
let renderTimer = null, renderPending = false;
function scheduleRender(){
  if (renderTimer) { renderPending = true; return; }
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render();
    if (renderPending){ renderPending = false; scheduleRender(); }
  }, 60);
}

function targetPx(){
  const W = Math.max(1, Math.round(params.wmm/25.4*params.dpi));
  const H = Math.max(1, Math.round(params.hmm/25.4*params.dpi));
  return {W, H};
}

function render(){
  if (!state.source || state.cropMode) return;
  const {W, H} = targetPx();
  const warnEl = $('warn');
  if (W*H > 40e6){
    warnEl.style.display='block';
    warnEl.textContent = `Large output: ${(W*H/1e6).toFixed(0)} megapixels — processing and export may be slower.`;
  } else {
    warnEl.style.display='none';
  }
  $('busy').style.display='inline';

  // let the busy indicator paint before the heavy work
  // (plain setTimeout, not rAF — rAF never fires in a hidden/background tab)
  setTimeout(() => {
    try { renderCore(W, H); }
    finally { $('busy').style.display='none'; }
  }, 15);
}

function renderCore(W, H){
  const work = document.createElement('canvas');
  work.width=W; work.height=H;
  const wx = work.getContext('2d');
  wx.imageSmoothingQuality='high';
  wx.drawImage(state.source, 0, 0, W, H);
  const img = wx.getImageData(0,0,W,H);
  const p = img.data;

  const N = W*H;
  let gray = new Float32Array(N);
  const mask = new Uint8Array(N);
  for (let i=0, j=0; i<N; i++, j+=4){
    mask[i] = p[j+3] >= 128 ? 1 : 0;
    gray[i] = 0.2126*p[j] + 0.7152*p[j+1] + 0.0722*p[j+2];
  }

  // brightness / contrast / gamma via LUT
  const c = params.contrast;
  const f = (259*(c+255))/(255*(259-c));
  const invG = 1/params.gamma;
  const lut = new Float32Array(256);
  for (let v=0; v<256; v++){
    let o = f*(v-128)+128 + params.brightness;
    o = Math.min(255, Math.max(0, o));
    o = 255*Math.pow(o/255, invG);
    lut[v] = o;
  }
  for (let i=0;i<N;i++) gray[i] = lut[Math.min(255, Math.max(0, Math.round(gray[i])))];

  // unsharp mask
  if (params.usRadius > 0 && params.usAmount > 0){
    const sigma = params.usRadius/2;
    const blur = gaussianBlur(gray, W, H, sigma);
    const amt = params.usAmount/100;
    for (let i=0;i<N;i++){
      const v = gray[i] + (gray[i]-blur[i])*amt;
      gray[i] = Math.min(255, Math.max(0, v));
    }
  }

  // sketch pre-process (colour-dodge pencil effect)
  if (params.algo === 'sketch'){
    const inv = new Float32Array(N);
    for (let i=0;i<N;i++) inv[i] = 255-gray[i];
    const bl = gaussianBlur(inv, W, H, Math.max(2, Math.min(W,H)*0.008));
    for (let i=0;i<N;i++){
      const den = 255-bl[i];
      const dodge = den <= 0 ? 255 : Math.min(255, gray[i]*255/den);
      gray[i] = dodge*0.88 + gray[i]*0.12;
    }
  }

  // invert
  if (params.invert)
    for (let i=0;i<N;i++) gray[i] = 255-gray[i];

  // dither
  let burn;
  const a = params.algo;
  if (a === 'bayer')          burn = orderedDither(gray, W, H, mask, BAYER8);
  else if (a === 'halftone')  burn = orderedDither(gray, W, H, mask, DOT8);
  else if (a === 'threshold') burn = thresholdDither(gray, W, H, mask);
  else if (a === 'sketch')    burn = errorDiffuse(gray, W, H, mask, KERNELS.jarvis);
  else                        burn = errorDiffuse(gray, W, H, mask, KERNELS[a]);

  state.base = {burn, mask, W, H};
  retext();
  updateInfo();
}

/* ---------------- text overlay ----------------
   Text lives in BOARD space (or image space when there is no board), fully
   independent of the photo: it renders on its own canvas layer over the whole
   board, so it can sit anywhere — over the photo or out on the bare material.

   Two things happen each time text changes:
   1. a "hole" is cut in the photo raster wherever a glyph (or its offset
      keep-out halo) overlaps the image — this is what gives knockout text
      its bare-material look and keeps the photo from crowding the letters;
   2. the engraved (burn-mode) glyphs are painted on the overlay layer.
   Because the photo dither itself is cached, dragging text never re-runs the
   dither pipeline. */

/* image position within the content/board area, in image px */
function imgOffset(){
  return params.boardOn
    ? {ox: Math.round(mm2px(params.posX)), oy: Math.round(mm2px(params.posY))}
    : {ox: 0, oy: 0};
}

/* render each visible text once; record hit-boxes in CONTENT (board) px */
function textItems(){
  const items = [];
  state.textBoxes = state.texts.map(() => null);
  state.texts.forEach((t, idx) => {
    if (!String(t.text).trim()) return;
    const r = renderTextItem(t);   // x0,y0 in content px
    state.textBoxes[idx] = {x: r.x0, y: r.y0, w: r.c.width, h: r.c.height};
    items.push({t, r});
  });
  return items;
}

function retext(){
  if (!state.base) return;
  const {W, H} = state.base;
  const burn = new Uint8Array(state.base.burn);
  const mask = new Uint8Array(state.base.mask);
  const {ox, oy} = imgOffset();
  const items = textItems();
  // cut holes in the photo (content px → image px via the image offset):
  // the offset halo first, then the glyph itself — for every text, both
  // modes. Knockout letters show the bare hole; burn letters get the same
  // clean space and are then painted on top by the overlay layer.
  for (const {r} of items){
    if (r.halo) stampCanvas(r.halo, r.x0 - ox, r.y0 - oy, W, H, i => { burn[i] = 0; });
    stampCanvas(r.c, r.x0 - ox, r.y0 - oy, W, H, i => { burn[i] = 0; });
  }
  state.out = {burn, mask, W, H};
  state.textItems = items;
  drawPreview();
}
let textTimer = null;
function retextSchedule(){
  if (textTimer) return;
  textTimer = setTimeout(() => { textTimer = null; retext(); }, 30);
}

/* render one text item, centred on (x,y) mm. Returns the glyph canvas and,
   when t.offset > 0, a halo canvas: the glyphs dilated by the offset
   distance (a fat round-join stroke around the outline is a true outward
   offset, like LightBurn's offset shape). */
function renderTextItem(t){
  const px = Math.max(2, mm2px(t.size));
  const rPx = Math.max(0, mm2px(t.offset || 0));
  const lines = String(t.text).split('\n');
  const fontStr = `${t.italic?'italic ':''}${t.bold?'bold ':''}${px}px "${t.font}"`;
  const lh = px*1.25;
  const meas = renderTextItem.ctx ||
    (renderTextItem.ctx = document.createElement('canvas').getContext('2d'));
  meas.font = fontStr;
  let tw = 1;
  for (const ln of lines) tw = Math.max(tw, meas.measureText(ln).width);
  const th = lh*lines.length;
  const rad = (t.rot||0)*Math.PI/180;
  const pad = 2 + Math.ceil(rPx);
  const bw = Math.min(16000, Math.ceil(tw*Math.abs(Math.cos(rad)) + th*Math.abs(Math.sin(rad))) + 2*pad);
  const bh = Math.min(16000, Math.ceil(tw*Math.abs(Math.sin(rad)) + th*Math.abs(Math.cos(rad))) + 2*pad);
  const draw = dilate => {
    const c = document.createElement('canvas');
    c.width = bw; c.height = bh;
    const x = c.getContext('2d');
    x.font = fontStr;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillStyle = x.strokeStyle = '#000';
    x.translate(bw/2, bh/2);
    x.rotate(rad);
    if (dilate){ x.lineWidth = rPx*2; x.lineJoin = 'round'; x.lineCap = 'round'; }
    lines.forEach((ln, i) => {
      const y = (i - (lines.length-1)/2)*lh;
      if (dilate) x.strokeText(ln, 0, y);
      x.fillText(ln, 0, y);
    });
    return c;
  };
  return {c: draw(false), halo: rPx >= 1 ? draw(true) : null,
          x0: Math.round(mm2px(t.x) - bw/2), y0: Math.round(mm2px(t.y) - bh/2)};
}

/* stamp every alpha>=128 pixel of a canvas into the target arrays */
function stampCanvas(c, x0, y0, W, H, put){
  const cw = c.width, ch = c.height;
  const d = c.getContext('2d').getImageData(0, 0, cw, ch).data;
  for (let yy = 0; yy < ch; yy++){
    const gy = y0 + yy;
    if (gy < 0 || gy >= H) continue;
    for (let xx = 0; xx < cw; xx++){
      const gx = x0 + xx;
      if (gx < 0 || gx >= W) continue;
      if (d[(yy*cw + xx)*4 + 3] < 128) continue;   // hard edge, no AA speckle
      put(gy*W + gx);
    }
  }
}

/* recolour a black glyph canvas (keeps its alpha shape) */
function colorizeGlyph(glyph, colorStr){
  const c = document.createElement('canvas');
  c.width = glyph.width; c.height = glyph.height;
  const x = c.getContext('2d');
  x.drawImage(glyph, 0, 0);
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = colorStr;
  x.fillRect(0, 0, c.width, c.height);
  return c;
}

/* paint every burn-mode glyph onto ctx, scaling content px by k.
   knockout glyphs paint nothing — their bare-material look comes from the
   hole already cut in the photo (or from untouched material off the photo). */
function paintBurnText(ctx, k, colorStr){
  for (const {t, r} of (state.textItems || [])){
    if (t.mode !== 'burn') continue;
    const g = colorizeGlyph(r.c, colorStr);
    ctx.drawImage(g, r.x0*k, r.y0*k, r.c.width*k, r.c.height*k);
  }
}

/* the text overlay layer, sized to the whole board (content) area */
const TEXT_MAX = 2400;
function drawTextLayer(){
  const tc = $('textCanvas');
  const c = contentPx();
  if (!c){ tc.width = tc.height = 1; return; }
  const k = Math.min(1, TEXT_MAX/Math.max(c.cw, c.ch));
  const w = Math.max(1, Math.round(c.cw*k)), h = Math.max(1, Math.round(c.ch*k));
  if (tc.width !== w || tc.height !== h){ tc.width = w; tc.height = h; }
  const x = tc.getContext('2d');
  x.clearRect(0, 0, w, h);
  const mat = MATERIALS[params.material];
  const col = hexToRgb(mat.burn);
  const colorStr = params.previewMat
    ? `rgba(${col.r},${col.g},${col.b},${mat.alpha/255})` : '#000';
  paintBurnText(x, k, colorStr);
}

/* ---------------- preview drawing ---------------- */
function drawPreview(){
  if (!state.out) return;
  const {burn, mask, W, H} = state.out;
  const cv = $('previewCanvas');
  cv.width=W; cv.height=H;
  const x = cv.getContext('2d');

  x.clearRect(0,0,W,H);

  if (params.previewMat){
    const mat = MATERIALS[params.material];
    // on a board the material shows through from the board itself;
    // standalone, the canvas carries its own background
    if (!params.boardOn) drawMaterialBg(x, params.material, W, H, params.materialLandscape);
    x.drawImage(makeBurnLayer(isEngraveView()), 0, 0);
  } else {
    const layer = x.createImageData(W,H);
    const lp = layer.data;
    for (let i=0, j=0; i<burn.length; i++, j+=4){
      if (!mask[i]){
        if (!params.boardOn){ lp[j]=230; lp[j+1]=230; lp[j+2]=232; lp[j+3]=255; }
        continue; // on board: transparent, board shows through
      }
      if (burn[i]){ lp[j]=0; lp[j+1]=0; lp[j+2]=0; lp[j+3]=255; }
      else if (!params.boardOn){ lp[j]=255; lp[j+1]=255; lp[j+2]=255; lp[j+3]=255; }
    }
    x.putImageData(layer,0,0);
  }
  drawTextLayer();
  updateBoard();
  $('dropMsg').style.display='none';
  $('boardWrap').style.display='block';
}

function hexToRgb(h){
  return {r:parseInt(h.slice(1,3),16), g:parseInt(h.slice(3,5),16), b:parseInt(h.slice(5,7),16)};
}

/* engraved view is on when the toolbar toggle is active OR while
   previewing placement on the board — both are "customer view" modes */
const isEngraveView = () => params.engrave || (params.boardOn && params.boardPreview);

/* the burn marks as a transparent-backed canvas.
   engrave=false → raw dither dots. engrave=true → engraved look: a real
   laser dot is a ~0.15 mm spot, not a hard pixel; adjacent dots bleed and
   merge. Blur the dot mask into a coverage map and blend the burn colour
   by coverage — which is what the eye (and the customer) sees. */
function makeBurnLayer(engrave){
  const {burn, mask, W, H} = state.out;
  const mat = MATERIALS[params.material];
  const col = hexToRgb(mat.burn);
  const cvs = document.createElement('canvas');
  cvs.width=W; cvs.height=H;
  const ctx = cvs.getContext('2d');
  const layer = ctx.createImageData(W,H);
  const lp = layer.data;
  if (engrave){
    const N = W*H;
    let cov = new Float32Array(N);
    for (let i=0;i<N;i++) cov[i] = burn[i] ? 1 : 0;
    cov = gaussianBlur(cov, W, H, Math.max(1.3, 0.08*mm2px(1)));
    for (let i=0, j=0; i<N; i++, j+=4){
      if (!mask[i]) continue;
      const a = Math.min(1, cov[i]*1.2);   // slight dot gain
      if (a > 0.02){
        lp[j]=col.r; lp[j+1]=col.g; lp[j+2]=col.b;
        lp[j+3] = Math.round(Math.pow(a, 0.85) * mat.alpha);
      }
    }
  } else {
    const rnd = mulberry32(7);
    for (let i=0, j=0; i<burn.length; i++, j+=4){
      if (burn[i]){
        lp[j]=col.r; lp[j+1]=col.g; lp[j+2]=col.b;
        lp[j+3]=Math.max(140, Math.min(255, mat.alpha + (rnd()-0.5)*50));
      }
    }
  }
  ctx.putImageData(layer,0,0);
  return cvs;
}

let curScale = 1;
function mm2px(mm){ return mm/25.4*params.dpi; }

/* board size in mm. A round board is a circle, so its bounding box is square
   at the diameter — boardH is left untouched so unticking Round restores it. */
function boardMM(){
  return {w: params.boardW, h: params.boardRound ? params.boardW : params.boardH};
}

/* clip a canvas context to the board outline (no-op on a square board) */
function clipBoard(ctx, w, h){
  if (!params.boardOn || !params.boardRound) return false;
  ctx.beginPath();
  ctx.ellipse(w/2, h/2, w/2, h/2, 0, 0, Math.PI*2);
  ctx.clip();
  return true;
}

/* content = what fills the stage: the board (if shown) or just the image */
function contentPx(){
  const o = state.out || state.base;
  if (!o) return null;
  const {W, H} = o;
  if (params.boardOn){
    const b = boardMM();
    return {cw: Math.max(1, Math.round(mm2px(b.w))),
            ch: Math.max(1, Math.round(mm2px(b.h))),
            ox: Math.round(mm2px(params.posX)),
            oy: Math.round(mm2px(params.posY)), W, H};
  }
  return {cw: W, ch: H, ox: 0, oy: 0, W, H};
}

function applyZoom(){
  const st = $('stage');
  if (state.cropMode){
    const cv = $('cropCanvas');
    if (!cv.width) return;
    const s = params.zoom === 'fit'
      ? Math.min((st.clientWidth-40)/cv.width, (st.clientHeight-40)/cv.height, 1)
      : parseFloat(params.zoom);
    curScale = s;
    cv.style.width  = Math.max(1, Math.round(cv.width*s))+'px';
    cv.style.height = Math.max(1, Math.round(cv.height*s))+'px';
    updateMinimap();
    return;
  }
  const c = contentPx();
  if (!c) return;
  let s;
  if (params.zoom === 'fit')
    s = Math.min((st.clientWidth-40)/c.cw, (st.clientHeight-40)/c.ch, 1);
  else s = parseFloat(params.zoom);
  curScale = s;
  const bwEl = $('boardWrap'), cv = $('previewCanvas');
  bwEl.style.width  = Math.max(1, Math.round(c.cw*s))+'px';
  bwEl.style.height = Math.max(1, Math.round(c.ch*s))+'px';
  cv.style.width  = Math.max(1, Math.round(c.W*s))+'px';
  cv.style.height = Math.max(1, Math.round(c.H*s))+'px';
  cv.style.left = Math.round(c.ox*s)+'px';
  cv.style.top  = Math.round(c.oy*s)+'px';
  // crisp dots only when zoomed in on the raw dither; smooth otherwise
  // (nearest-neighbour downscaling is what makes the fit view look harsh)
  cv.classList.toggle('pixelated', curScale >= 1 && !isEngraveView());
  updateMinimap();
}

function setZoom(v){
  params.zoom = v;
  const sel = $('zoom'), co = $('zoomCustom');
  const fixed = ['fit','0.25','0.5','1','2','4'];
  const str = String(v);
  if (fixed.includes(str)){
    co.hidden = true;
    sel.value = str;
  } else {
    co.hidden = false;
    co.value = str;
    co.textContent = Math.round(v*100)+'%';
    sel.value = str;
  }
  applyZoom();
}

/* scroll-wheel zoom, centred on the cursor */
const stageEl = $('stage');
stageEl.addEventListener('wheel', e => {
  if (state.cropMode || !state.out) return;
  e.preventDefault();
  const el = $('boardWrap');
  const factor = e.deltaY < 0 ? 1.25 : 0.8;
  const s2 = Math.min(8, Math.max(0.03, curScale*factor));
  const rect = el.getBoundingClientRect();
  const ix = (e.clientX-rect.left)/curScale;   // content-space point under cursor
  const iy = (e.clientY-rect.top)/curScale;
  setZoom(Math.round(s2*1000)/1000);
  const stRect = stageEl.getBoundingClientRect();
  stageEl.scrollLeft = el.offsetLeft + ix*curScale - (e.clientX - stRect.left);
  stageEl.scrollTop  = el.offsetTop  + iy*curScale - (e.clientY - stRect.top);
  updateMinimap();
}, {passive:false});

/* middle-button drag to pan */
let pan = null;
stageEl.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
stageEl.addEventListener('auxclick',  e => { if (e.button === 1) e.preventDefault(); });
stageEl.addEventListener('pointerdown', e => {
  if (e.button !== 1) return;
  e.preventDefault();
  pan = {x:e.clientX, y:e.clientY, sl:stageEl.scrollLeft, st:stageEl.scrollTop};
  stageEl.setPointerCapture(e.pointerId);
  stageEl.style.cursor = 'grabbing';
});
stageEl.addEventListener('pointermove', e => {
  if (!pan) return;
  stageEl.scrollLeft = pan.sl - (e.clientX - pan.x);
  stageEl.scrollTop  = pan.st - (e.clientY - pan.y);
});
stageEl.addEventListener('pointerup', () => {
  if (pan){ pan = null; stageEl.style.cursor = ''; }
});
stageEl.addEventListener('scroll', () => updateMinimap());

/* ---------------- minimap ---------------- */
const MINI_MAX = 180;
function updateMinimap(){
  const mini = $('minimap'), mc = $('minimapCanvas'), box = $('minimapBox');
  const bwEl = $('boardWrap'), cv = $('previewCanvas');
  const c = contentPx();
  if (state.cropMode || !c || bwEl.style.display === 'none'){
    mini.style.display = 'none'; return;
  }
  const dispW = c.cw*curScale, dispH = c.ch*curScale;
  if (dispW <= stageEl.clientWidth+1 && dispH <= stageEl.clientHeight+1){
    mini.style.display = 'none'; return;
  }
  mini.style.display = 'block';
  const k = Math.min(MINI_MAX/c.cw, MINI_MAX/c.ch);
  const mw = Math.max(1, Math.round(c.cw*k));
  const mh = Math.max(1, Math.round(c.ch*k));
  if (mc.width !== mw || mc.height !== mh){ mc.width = mw; mc.height = mh; }
  const mx = mc.getContext('2d');
  mx.clearRect(0,0,mw,mh);
  if (params.boardOn){
    if (params.previewMat) drawMaterialBg(mx, params.material, mw, mh, params.materialLandscape);
    else { mx.fillStyle='#fff'; mx.fillRect(0,0,mw,mh); }
    mx.drawImage(cv, c.ox*k, c.oy*k, c.W*k, c.H*k);
  } else {
    mx.drawImage(cv, 0, 0, mw, mh);
  }
  // viewport box
  const mm = mw/dispW;
  const vx = Math.max(0, stageEl.scrollLeft - bwEl.offsetLeft);
  const vy = Math.max(0, stageEl.scrollTop  - bwEl.offsetTop);
  const vw = Math.min(dispW, stageEl.scrollLeft + stageEl.clientWidth  - bwEl.offsetLeft) - vx;
  const vh = Math.min(dispH, stageEl.scrollTop  + stageEl.clientHeight - bwEl.offsetTop)  - vy;
  box.style.left   = (4 + vx*mm)+'px';
  box.style.top    = (4 + vy*mm)+'px';
  box.style.width  = Math.max(6, vw*mm)+'px';
  box.style.height = Math.max(6, vh*mm)+'px';
}

/* drag the minimap to move the view */
let miniDrag = false;
function miniJump(e){
  const mc = $('minimapCanvas'), r = mc.getBoundingClientRect();
  const c = contentPx();
  if (!c) return;
  const k = r.width/(c.cw*curScale);   // minimap px per display px
  const cx = (e.clientX-r.left)/k, cy = (e.clientY-r.top)/k;
  stageEl.scrollLeft = $('boardWrap').offsetLeft + cx - stageEl.clientWidth/2;
  stageEl.scrollTop  = $('boardWrap').offsetTop  + cy - stageEl.clientHeight/2;
}
$('minimap').addEventListener('pointerdown', e => {
  miniDrag = true;
  $('minimap').setPointerCapture(e.pointerId);
  miniJump(e);
});
$('minimap').addEventListener('pointermove', e => { if (miniDrag) miniJump(e); });
$('minimap').addEventListener('pointerup',   () => miniDrag = false);

/* ---------------- board / workpiece ---------------- */
function clampPos(){
  const b = boardMM();
  const fx = b.w - params.wmm, fy = b.h - params.hmm;
  params.posX = Math.min(Math.max(0,fx), Math.max(Math.min(0,fx), params.posX));
  params.posY = Math.min(Math.max(0,fy), Math.max(Math.min(0,fy), params.posY));
}
function syncPosInputs(){
  $('posX').value = Math.round(params.posX*10)/10;
  $('posY').value = Math.round(params.posY*10)/10;
}
function centerOnBoard(){
  const b = boardMM();
  params.posX = (b.w - params.wmm)/2;
  params.posY = (b.h - params.hmm)/2;
  syncPosInputs();
}
function updateBoard(){
  const bwEl = $('boardWrap'), cv = $('previewCanvas');
  bwEl.classList.toggle('boardOn', params.boardOn);
  bwEl.classList.toggle('round',  params.boardOn && params.boardRound);
  bwEl.classList.toggle('guides', params.boardOn && !params.boardPreview);
  bwEl.classList.toggle('clip',   params.boardOn && params.boardPreview);
  cv.classList.toggle('dashed',   params.boardOn && !params.boardPreview);
  const bg = $('boardBg');
  if (params.boardOn && params.previewMat){
    const c = contentPx();
    if (c){
      // internal resolution capped; CSS stretches it to the board
      const k = Math.min(1, 1600/Math.max(c.cw, c.ch));
      const w = Math.max(1, Math.round(c.cw*k)), h = Math.max(1, Math.round(c.ch*k));
      if (bg.width !== w || bg.height !== h){ bg.width = w; bg.height = h; }
      drawMaterialBg(bg.getContext('2d'), params.material, w, h, params.materialLandscape);
    }
    bg.style.display = 'block';
    bwEl.style.backgroundColor = '';
  } else if (params.boardOn){
    bg.style.display = 'none';
    bwEl.style.backgroundColor = '#ffffff';
  } else {
    bg.style.display = 'none';
    bwEl.style.backgroundColor = 'transparent';
  }
  applyZoom();
  updateInfo();
}

/* drag text (topmost hit) or, on a board, the image itself.
   All hit-testing is in CONTENT (board) space — the text layer covers the
   whole board, so text is grabbable anywhere, not just over the photo. */
let imgDrag = null, txtDrag = null;
const textLayer = $('textCanvas');
function contentPtr(e){
  const r = textLayer.getBoundingClientRect();
  const c = contentPx();
  if (!c || !r.width) return null;
  return {cx: (e.clientX - r.left)/r.width * c.cw,
          cy: (e.clientY - r.top) /r.height * c.ch, c};
}
function textHit(p){
  if (!p) return -1;
  for (let i = state.texts.length-1; i >= 0; i--){
    const b = state.textBoxes[i];
    if (b && p.cx >= b.x && p.cx <= b.x+b.w && p.cy >= b.y && p.cy <= b.y+b.h) return i;
  }
  return -1;
}
const overImage = p => p && params.boardOn &&
  p.cx >= p.c.ox && p.cx <= p.c.ox+p.c.W && p.cy >= p.c.oy && p.cy <= p.c.oy+p.c.H;

textLayer.addEventListener('pointerdown', e => {
  if (e.button !== 0 || state.cropMode) return;
  const p = contentPtr(e);
  const hit = textHit(p);
  if (hit >= 0){
    e.preventDefault();
    selectText(hit);
    const t = state.texts[hit];
    txtDrag = {i:hit, x:e.clientX, y:e.clientY, tx:t.x, ty:t.y};
    textLayer.setPointerCapture(e.pointerId);
    return;
  }
  if (!overImage(p)) return;
  e.preventDefault();
  imgDrag = {x:e.clientX, y:e.clientY, px:params.posX, py:params.posY};
  textLayer.setPointerCapture(e.pointerId);
});
textLayer.addEventListener('pointermove', e => {
  const pxPerMm = mm2px(1)*curScale;
  if (txtDrag){
    const t = state.texts[txtDrag.i];
    if (!t){ txtDrag = null; return; }
    t.x = txtDrag.tx + (e.clientX-txtDrag.x)/pxPerMm;
    t.y = txtDrag.ty + (e.clientY-txtDrag.y)/pxPerMm;
    syncTextEditor();
    retextSchedule();
    return;
  }
  if (imgDrag){
    params.posX = imgDrag.px + (e.clientX-imgDrag.x)/pxPerMm;
    params.posY = imgDrag.py + (e.clientY-imgDrag.y)/pxPerMm;
    clampPos(); syncPosInputs(); applyZoom(); updateInfo(); retextSchedule();
    return;
  }
  if (!state.cropMode){
    const p = contentPtr(e);
    textLayer.style.cursor = textHit(p) >= 0 ? 'move' : (overImage(p) ? 'move' : 'default');
  }
});
textLayer.addEventListener('pointerup', () => {
  const settle = imgDrag || txtDrag;
  imgDrag = null; txtDrag = null;
  if (settle) retext();   // settle final position (halo/knockout follow)
});

/* board geometry moved → recut photo holes & repaint the text overlay
   (both depend on the image's position/size within the board) */
function refresh(){ if (state.base) retext(); else updateBoard(); }

$('boardOn').onchange = e => {
  params.boardOn = e.target.checked;
  $('boardCtl').style.display = params.boardOn ? 'block' : 'none';
  if (params.boardOn) centerOnBoard();
  refresh();
};
/* a round board is defined by one number, so width becomes the diameter
   and the height row is hidden (its value is kept for switching back) */
function syncBoardShape(){
  $('boardWLabel').textContent = params.boardRound ? 'Diameter (mm)' : 'Width (mm)';
  $('boardHRow').style.display = params.boardRound ? 'none' : '';
}
$('boardRound').onchange = e => {
  params.boardRound = e.target.checked;
  syncBoardShape();
  centerOnBoard();
  refresh();
};
$('boardW').addEventListener('change', e => {
  params.boardW = Math.min(3000, Math.max(10, parseFloat(e.target.value)||10));
  e.target.value = params.boardW;
  clampPos(); syncPosInputs(); refresh();
});
$('boardH').addEventListener('change', e => {
  params.boardH = Math.min(3000, Math.max(10, parseFloat(e.target.value)||10));
  e.target.value = params.boardH;
  clampPos(); syncPosInputs(); refresh();
});
$('posX').addEventListener('change', e => {
  params.posX = parseFloat(e.target.value)||0;
  clampPos(); syncPosInputs(); applyZoom(); updateInfo(); refresh();
});
$('posY').addEventListener('change', e => {
  params.posY = parseFloat(e.target.value)||0;
  clampPos(); syncPosInputs(); applyZoom(); updateInfo(); refresh();
});
$('btnCenter').onclick = () => { centerOnBoard(); applyZoom(); updateInfo(); refresh(); };
$('btnBoardPreview').onclick = () => {
  params.boardPreview = !params.boardPreview;
  const b = $('btnBoardPreview');
  b.textContent = params.boardPreview ? 'Back to editing' : 'Preview placement';
  b.classList.toggle('primary', params.boardPreview);
  drawPreview();   // re-render: placement preview uses the engraved look
};

function updateInfo(){
  const {W, H} = targetPx();
  $('pxInfo').textContent = `${W} × ${H} px`;
  let t = `${W} × ${H} px  •  ${params.wmm} × ${params.hmm} mm @ ${params.dpi} DPI  •  ${params.algo}`;
  if (params.boardOn){
    const b = boardMM();
    const size = params.boardRound ? `⌀ ${b.w} mm round` : `${b.w} × ${b.h} mm`;
    t = `board ${size}  •  image at ${Math.round(params.posX*10)/10}, ${Math.round(params.posY*10)/10} mm  •  ` + t;
  }
  $('info').textContent = t;
}

/* ---------------- image loading ---------------- */
function loadImage(src){
  const img = new Image();
  img.onload = () => {
    state.original = img;
    state.crop = null;
    setSourceFromOriginal();
    exitCropMode();
    // sensible default size: 100 mm wide
    params.wmm = 100;
    params.hmm = round1(100*state.aspect);
    $('wmm').value = params.wmm;
    $('hmm').value = params.hmm;
    scheduleRender();
  };
  img.onerror = () => alert('Could not load that image.');
  img.src = src;
}

function setSourceFromOriginal(circle){
  const im = state.original;
  const cr = state.crop || {x:0, y:0, w:im.naturalWidth||im.width, h:im.naturalHeight||im.height};
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(cr.w));
  c.height = Math.max(1, Math.round(cr.h));
  const x = c.getContext('2d');
  x.drawImage(im, cr.x, cr.y, cr.w, cr.h, 0, 0, c.width, c.height);
  if (circle){
    x.globalCompositeOperation='destination-in';
    x.beginPath();
    x.ellipse(c.width/2, c.height/2, c.width/2, c.height/2, 0, 0, Math.PI*2);
    x.fill();
    x.globalCompositeOperation='source-over';
  }
  state.source = c;
  state.aspect = c.height/c.width;
  if (params.lockAspect){
    params.hmm = round1(params.wmm*state.aspect);
    $('hmm').value = params.hmm;
  }
}
const round1 = v => Math.round(v*10)/10;

/* file open / drop / paste */
$('btnOpen').onclick = () => $('fileInput').click();
$('fileInput').onchange = e => {
  const f = e.target.files[0];
  if (f) loadImage(URL.createObjectURL(f));
  e.target.value = '';
};
const stage = $('stage');
['dragover','dragenter'].forEach(ev => document.addEventListener(ev, e => {
  e.preventDefault(); stage.classList.add('dragover');
}));
['dragleave','drop'].forEach(ev => document.addEventListener(ev, e => {
  e.preventDefault(); stage.classList.remove('dragover');
}));
document.addEventListener('drop', e => {
  const f = [...e.dataTransfer.files].find(f => f.type.startsWith('image/'));
  if (f) loadImage(URL.createObjectURL(f));
});
document.addEventListener('paste', e => {
  const it = [...e.clipboardData.items].find(i => i.type.startsWith('image/'));
  if (it) loadImage(URL.createObjectURL(it.getAsFile()));
});

/* test image: gradient sphere + bars + text — good for judging dithers */
$('btnSample').onclick = () => {
  const c = document.createElement('canvas');
  c.width = 900; c.height = 640;
  const x = c.getContext('2d');
  const lin = x.createLinearGradient(0,0,900,0);
  lin.addColorStop(0,'#000'); lin.addColorStop(1,'#fff');
  x.fillStyle = lin; x.fillRect(0,0,900,640);
  const rad = x.createRadialGradient(450,300,20,450,300,240);
  rad.addColorStop(0,'#fff'); rad.addColorStop(1,'#111');
  x.fillStyle = rad;
  x.beginPath(); x.arc(450,300,220,0,7); x.fill();
  for (let i=0;i<10;i++){
    x.fillStyle = `hsl(0,0%,${i*11}%)`;
    x.fillRect(40+i*82, 560, 78, 60);
  }
  x.fillStyle='#000'; x.font='bold 46px Segoe UI';
  x.fillText('Laser Dither Test', 40, 70);
  x.fillStyle='#fff';
  x.fillText('Laser Dither Test', 500, 530);
  loadImage(c.toDataURL());
};

/* ---------------- crop mode ---------------- */
const cropUI = {scale:1, drag:null};

$('btnCrop').onclick = () => { if (state.original) enterCropMode(); };
$('btnCropCancel').onclick = exitCropMode;
$('btnCropReset').onclick = () => {
  if (!state.original) return;
  state.crop = null;
  setSourceFromOriginal(false);
  exitCropMode();
  scheduleRender();
};
$('btnCropApply').onclick = () => {
  setSourceFromOriginal($('cropCircle').checked);
  exitCropMode();
  scheduleRender();
};
$('cropCircle').onchange = () => {
  if (state.cropMode){ constrainCircle(); drawCrop(); }
};

function enterCropMode(){
  state.cropMode = true;
  $('boardWrap').style.display='none';
  $('dropMsg').style.display='none';
  $('cropActions').style.display='flex';
  const im = state.original;
  const iw = im.naturalWidth||im.width, ih = im.naturalHeight||im.height;
  if (!state.crop) state.crop = {x:iw*0.1, y:ih*0.1, w:iw*0.8, h:ih*0.8};
  if ($('cropCircle').checked) constrainCircle();
  const cv = $('cropCanvas');
  const st = $('stage');
  cropUI.scale = Math.min((st.clientWidth-60)/iw, (st.clientHeight-60)/ih, 1);
  cv.width  = Math.round(iw*cropUI.scale);
  cv.height = Math.round(ih*cropUI.scale);
  cv.style.width = cv.width+'px';
  cv.style.height = cv.height+'px';
  cv.style.display='block';
  drawCrop();
}

function exitCropMode(){
  state.cropMode = false;
  $('cropCanvas').style.display='none';
  $('cropActions').style.display='none';
  if (state.source){
    $('boardWrap').style.display='block';
    $('dropMsg').style.display='none';
  }
}

function constrainCircle(){
  const cr = state.crop; if (!cr) return;
  const s = Math.min(cr.w, cr.h);
  cr.x += (cr.w-s)/2; cr.y += (cr.h-s)/2;
  cr.w = cr.h = s;
}

function drawCrop(){
  const cv = $('cropCanvas'), x = cv.getContext('2d');
  const im = state.original, s = cropUI.scale, cr = state.crop;
  x.clearRect(0,0,cv.width,cv.height);
  x.drawImage(im, 0, 0, cv.width, cv.height);
  // dim outside
  x.fillStyle='rgba(0,0,0,0.55)';
  x.beginPath();
  x.rect(0,0,cv.width,cv.height);
  if ($('cropCircle').checked)
    x.ellipse(s*(cr.x+cr.w/2), s*(cr.y+cr.h/2), s*cr.w/2, s*cr.h/2, 0, 0, Math.PI*2, true);
  else {
    // counter-clockwise inner rect to punch a hole
    x.moveTo(s*cr.x, s*cr.y);
    x.lineTo(s*cr.x, s*(cr.y+cr.h));
    x.lineTo(s*(cr.x+cr.w), s*(cr.y+cr.h));
    x.lineTo(s*(cr.x+cr.w), s*cr.y);
    x.closePath();
  }
  x.fill('evenodd');
  // border
  x.strokeStyle='#4da3ff'; x.lineWidth=1.5;
  if ($('cropCircle').checked){
    x.beginPath();
    x.ellipse(s*(cr.x+cr.w/2), s*(cr.y+cr.h/2), s*cr.w/2, s*cr.h/2, 0, 0, Math.PI*2);
    x.stroke();
  }
  x.strokeRect(s*cr.x, s*cr.y, s*cr.w, s*cr.h);
  // handles
  x.fillStyle='#4da3ff';
  for (const [hx,hy] of cropHandles()){
    x.fillRect(hx-5, hy-5, 10, 10);
  }
}
function cropHandles(){
  const s=cropUI.scale, cr=state.crop;
  return [
    [s*cr.x, s*cr.y], [s*(cr.x+cr.w), s*cr.y],
    [s*cr.x, s*(cr.y+cr.h)], [s*(cr.x+cr.w), s*(cr.y+cr.h)],
  ];
}

$('cropCanvas').addEventListener('pointerdown', e => {
  const cv=$('cropCanvas'), r=cv.getBoundingClientRect();
  const px=e.clientX-r.left, py=e.clientY-r.top;
  const hs = cropHandles();
  const names=['nw','ne','sw','se'];
  cropUI.drag=null;
  for (let i=0;i<4;i++){
    if (Math.abs(px-hs[i][0])<12 && Math.abs(py-hs[i][1])<12){
      cropUI.drag={type:names[i], sx:px, sy:py, start:{...state.crop}};
      break;
    }
  }
  const s=cropUI.scale, cr=state.crop;
  if (!cropUI.drag &&
      px>s*cr.x && px<s*(cr.x+cr.w) && py>s*cr.y && py<s*(cr.y+cr.h))
    cropUI.drag={type:'move', sx:px, sy:py, start:{...state.crop}};
  if (cropUI.drag) cv.setPointerCapture(e.pointerId);
});
$('cropCanvas').addEventListener('pointermove', e => {
  if (!cropUI.drag) return;
  const cv=$('cropCanvas'), r=cv.getBoundingClientRect();
  const px=e.clientX-r.left, py=e.clientY-r.top;
  const d=cropUI.drag, s=cropUI.scale;
  const dx=(px-d.sx)/s, dy=(py-d.sy)/s;
  const im=state.original;
  const iw=im.naturalWidth||im.width, ih=im.naturalHeight||im.height;
  const cr=state.crop, st=d.start;
  const circle=$('cropCircle').checked;
  const MIN=16;

  if (d.type==='move'){
    cr.x=Math.min(Math.max(0, st.x+dx), iw-st.w);
    cr.y=Math.min(Math.max(0, st.y+dy), ih-st.h);
  } else {
    let x0=st.x, y0=st.y, x1=st.x+st.w, y1=st.y+st.h;
    if (d.type.includes('w')) x0=Math.min(Math.max(0, st.x+dx), x1-MIN);
    if (d.type.includes('e')) x1=Math.max(Math.min(iw, st.x+st.w+dx), x0+MIN);
    if (d.type.includes('n')) y0=Math.min(Math.max(0, st.y+dy), y1-MIN);
    if (d.type.includes('s')) y1=Math.max(Math.min(ih, st.y+st.h+dy), y0+MIN);
    cr.x=x0; cr.y=y0; cr.w=x1-x0; cr.h=y1-y0;
    if (circle){
      const sz=Math.min(cr.w, cr.h);
      if (d.type.includes('w')) cr.x=x1-sz;
      if (d.type.includes('n')) cr.y=y1-sz;
      cr.w=cr.h=sz;
    }
  }
  drawCrop();
});
$('cropCanvas').addEventListener('pointerup', () => cropUI.drag=null);

/* ---------------- text UI ---------------- */

/* fallback font list — filtered down to what this machine actually has
   via canvas width probing (works offline / on file:// / in Firefox) */
const FONT_CANDIDATES = [
  'Arial','Arial Black','Bahnschrift','Book Antiqua','Brush Script MT',
  'Calibri','Cambria','Candara','Comic Sans MS','Consolas','Constantia',
  'Corbel','Courier New','Franklin Gothic Medium','Gabriola','Garamond',
  'Georgia','Impact','Ink Free','Lucida Console','Lucida Handwriting',
  'MV Boli','Palatino Linotype','Segoe Print','Segoe Script','Segoe UI',
  'Segoe UI Black','Sitka','Tahoma','Times New Roman','Trebuchet MS','Verdana',
  // common on mac/linux
  'Helvetica','Helvetica Neue','Futura','Optima','Baskerville','Didot',
  'American Typewriter','Chalkboard','Marker Felt','DejaVu Sans','Liberation Serif',
];
function detectFonts(){
  const ctx = document.createElement('canvas').getContext('2d');
  const SAMPLE = 'mmMWLil10@#';
  const differs = (fam, base) => {
    ctx.font = `40px ${base}`;
    const w = ctx.measureText(SAMPLE).width;
    ctx.font = `40px "${fam}", ${base}`;
    return ctx.measureText(SAMPLE).width !== w;
  };
  return FONT_CANDIDATES.filter(f => differs(f,'monospace') || differs(f,'serif'));
}

function populateFonts(families){
  const sel = $('txFont');
  const keep = sel.value;
  sel.innerHTML = '';
  for (const f of families){
    const o = document.createElement('option');
    o.value = f;
    o.textContent = f;
    o.style.fontFamily = `"${f}"`;   // dropdown shows each font rendered
    sel.appendChild(o);
  }
  if (families.includes(keep)) sel.value = keep;
  else sel.value = families.includes('Arial') ? 'Arial' : (families[0] || '');
}
populateFonts(detectFonts());

/* Local Font Access API — the full installed-font library. Chrome/Edge
   only, needs https or localhost, and must be called from a click. */
if (!('queryLocalFonts' in window)){
  const b = $('btnLocalFonts');
  b.disabled = true;
  b.title = 'Needs Chrome or Edge over https (or localhost) — using a built-in font list instead';
}
$('btnLocalFonts').onclick = async () => {
  try {
    const fonts = await window.queryLocalFonts();
    const fams = [...new Set(fonts.map(f => f.family))]
      .sort((a,b) => a.localeCompare(b));
    if (!fams.length){ alert('No fonts returned — permission may have been denied.'); return; }
    populateFonts(fams);
    const b = $('btnLocalFonts');
    b.textContent = `${fams.length} fonts loaded`;
    b.disabled = true;
    const t = curText();
    if (t){ $('txFont').value = fams.includes(t.font) ? t.font : $('txFont').value; }
  } catch(err){
    alert('Could not read local fonts: ' + err.message);
  }
};

const curText = () => state.texts[state.selText] || null;

function renderTextList(){
  const el = $('textList');
  el.innerHTML = '';
  state.texts.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'textItem' + (i === state.selText ? ' sel' : '');
    const label = document.createElement('span');
    label.textContent = String(t.text).split('\n')[0].slice(0, 28) || '(empty)';
    label.style.fontFamily = `"${t.font}"`;
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = 'Delete';
    del.onclick = e => { e.stopPropagation(); deleteText(i); };
    row.onclick = () => selectText(i);
    row.append(label, del);
    el.appendChild(row);
  });
}

function syncTextEditor(){
  const t = curText();
  $('textEd').style.display = t ? 'block' : 'none';
  if (!t) return;
  $('txText').value = t.text;
  if (![...$('txFont').options].some(o => o.value === t.font)){
    const o = document.createElement('option');
    o.value = o.textContent = t.font;
    o.style.fontFamily = `"${t.font}"`;
    $('txFont').appendChild(o);
  }
  $('txFont').value = t.font;
  $('txSize').value = t.size;
  $('txBold').classList.toggle('on', t.bold);
  $('txItalic').classList.toggle('on', t.italic);
  $('txMode').value = t.mode;
  $('txX').value = round1(t.x);
  $('txY').value = round1(t.y);
  $('txRot').value = t.rot;
  $('txOffset').value = t.offset || 0;
}

function selectText(i){
  state.selText = i;
  const sec = $('textEd').closest('.sec');
  if (sec) sec.classList.remove('closed');   // e.g. selected by clicking the preview
  renderTextList();
  syncTextEditor();
}
function deleteText(i){
  state.texts.splice(i, 1);
  if (state.selText >= state.texts.length) state.selText = state.texts.length-1;
  renderTextList();
  syncTextEditor();
  retextSchedule();
}

$('btnAddText').onclick = () => {
  if (!state.source){ alert('Load an image first, then add text on top of it.'); return; }
  // default position: near the top of whatever surface we're on (board or photo)
  const surfW = params.boardOn ? boardMM().w : params.wmm;
  const surfH = params.boardOn ? boardMM().h : params.hmm;
  state.texts.push({
    text: 'Your text', font: $('txFont').value || 'Arial',
    size: Math.max(3, round1(surfH/8)), bold: false, italic: false,
    mode: 'burn', x: round1(surfW/2), y: round1(surfH*0.12), rot: 0,
    offset: 3,
  });
  selectText(state.texts.length-1);
  retextSchedule();
};
$('btnDelText').onclick = () => { if (state.selText >= 0) deleteText(state.selText); };

$('txText').addEventListener('input', () => {
  const t = curText(); if (!t) return;
  t.text = $('txText').value;
  const row = $('textList').children[state.selText];
  if (row) row.firstChild.textContent = t.text.split('\n')[0].slice(0, 28) || '(empty)';
  retextSchedule();
});
$('txFont').onchange = () => {
  const t = curText(); if (!t) return;
  t.font = $('txFont').value;
  renderTextList();
  retextSchedule();
};
$('txSize').addEventListener('change', e => {
  const t = curText(); if (!t) return;
  t.size = Math.min(500, Math.max(1, parseFloat(e.target.value) || 10));
  e.target.value = t.size;
  retextSchedule();
});
$('txBold').onclick = () => {
  const t = curText(); if (!t) return;
  t.bold = !t.bold;
  $('txBold').classList.toggle('on', t.bold);
  retextSchedule();
};
$('txItalic').onclick = () => {
  const t = curText(); if (!t) return;
  t.italic = !t.italic;
  $('txItalic').classList.toggle('on', t.italic);
  retextSchedule();
};
$('txMode').onchange = () => {
  const t = curText(); if (!t) return;
  t.mode = $('txMode').value;
  retextSchedule();
};
$('txX').addEventListener('change', e => {
  const t = curText(); if (!t) return;
  t.x = parseFloat(e.target.value) || 0;
  retextSchedule();
});
$('txY').addEventListener('change', e => {
  const t = curText(); if (!t) return;
  t.y = parseFloat(e.target.value) || 0;
  retextSchedule();
});
$('txRot').addEventListener('change', e => {
  const t = curText(); if (!t) return;
  t.rot = Math.min(180, Math.max(-180, parseFloat(e.target.value) || 0));
  e.target.value = t.rot;
  retextSchedule();
});
$('txOffset').addEventListener('change', e => {
  const t = curText(); if (!t) return;
  t.offset = Math.min(50, Math.max(0, parseFloat(e.target.value) || 0));
  e.target.value = t.offset;
  retextSchedule();
});

/* ---------------- controls binding ---------------- */
function bindSlider(name){
  const sl=$(name), nb=$(name+'N');
  const set = v => {
    v = Math.min(parseFloat(sl.max), Math.max(parseFloat(sl.min), v));
    params[name]=v; sl.value=v; nb.value=v;
    scheduleRender();
  };
  sl.addEventListener('input', () => set(parseFloat(sl.value)));
  nb.addEventListener('change', () => set(parseFloat(nb.value)||0));
  return set;
}
const setBrightness = bindSlider('brightness');
const setContrast   = bindSlider('contrast');
const setGamma      = bindSlider('gamma');
const setUsRadius   = bindSlider('usRadius');
const setUsAmount   = bindSlider('usAmount');

$('btnResetAdj').onclick = () => {
  setBrightness(0); setContrast(0); setGamma(1); setUsRadius(0); setUsAmount(0);
};

$('material').onchange = e => {
  params.material = e.target.value;
  params.invert = MATERIALS[params.material].invert;
  $('invert').checked = params.invert;
  scheduleRender();
};
$('previewMat').onchange = e => {
  params.previewMat = e.target.checked;
  if (!params.previewMat && params.engrave){
    params.engrave = false;
    $('btnEngrave').classList.remove('primary');
  }
  drawPreview();
};
$('materialLandscape').onchange = e => {
  params.materialLandscape = e.target.checked;
  drawPreview();
};
$('btnEngrave').onclick = () => {
  params.engrave = !params.engrave;
  $('btnEngrave').classList.toggle('primary', params.engrave);
  if (params.engrave && !params.previewMat){
    params.previewMat = true;
    $('previewMat').checked = true;
  }
  drawPreview();
};
$('invert').onchange     = e => { params.invert = e.target.checked; scheduleRender(); };
$('algo').onchange       = e => { params.algo = e.target.value; scheduleRender(); };
$('zoom').onchange       = e => setZoom(e.target.value === 'fit' ? 'fit' : parseFloat(e.target.value));
$('lockAspect').onchange = e => { params.lockAspect = e.target.checked; };

$('wmm').addEventListener('change', e => {
  params.wmm = Math.max(1, parseFloat(e.target.value)||1);
  e.target.value = params.wmm;
  if (params.lockAspect){
    params.hmm = round1(params.wmm*state.aspect);
    $('hmm').value = params.hmm;
  }
  clampPos(); syncPosInputs();
  scheduleRender();
});
$('hmm').addEventListener('change', e => {
  params.hmm = Math.max(1, parseFloat(e.target.value)||1);
  e.target.value = params.hmm;
  if (params.lockAspect && state.aspect > 0){
    params.wmm = round1(params.hmm/state.aspect);
    $('wmm').value = params.wmm;
  }
  clampPos(); syncPosInputs();
  scheduleRender();
});
$('dpi').addEventListener('change', e => {
  params.dpi = Math.min(1200, Math.max(10, parseFloat(e.target.value)||254));
  e.target.value = params.dpi;
  scheduleRender();
});
window.addEventListener('resize', applyZoom);

/* ---------------- export ----------------
   The laser file is black = laser fires, white = skip. With a board shown it
   is the WHOLE plaque at board size: photo placed at its offset, engraved
   text stamped black, knockout text and offset halos left white (already cut
   from the photo raster). Without a board it is just the photo. */
$('btnExport').onclick = async () => {
  if (!state.out) return;
  const {burn, mask, W, H} = state.out;

  // the photo as black-fires-on-transparent, so it can be placed on the board
  const photo = document.createElement('canvas');
  photo.width = W; photo.height = H;
  const pimg = photo.getContext('2d').createImageData(W, H);
  const pp = pimg.data;
  for (let i=0, j=0; i<burn.length; i++, j+=4){
    if (mask[i] && burn[i]){ pp[j]=pp[j+1]=pp[j+2]=0; pp[j+3]=255; }
  }
  photo.getContext('2d').putImageData(pimg, 0, 0);

  const board = params.boardOn;
  const {ox, oy} = imgOffset();
  const b = boardMM();
  const cw = board ? Math.max(1, Math.round(mm2px(b.w))) : W;
  const ch = board ? Math.max(1, Math.round(mm2px(b.h))) : H;

  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const x = c.getContext('2d');
  // white = no laser. Transparent says the same thing to a human but not to
  // every importer, so it stays opt-in — a transparent source PNG otherwise
  // comes back with a white background, which is what most people expect.
  if (!params.exportAlpha){ x.fillStyle = '#fff'; x.fillRect(0, 0, cw, ch); }
  x.save();
  clipBoard(x, cw, ch);        // round board: nothing fires off the disc
  x.drawImage(photo, board ? ox : 0, board ? oy : 0);   // photo (black fires)
  paintBurnText(x, 1, '#000');                          // engraved text, black
  x.restore();

  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const buf = new Uint8Array(await blob.arrayBuffer());
  const withDpi = insertPngDpi(buf, params.dpi);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([withDpi], {type:'image/png'}));
  a.download = board
    ? (params.boardRound
        ? `plaque_round${b.w}mm_${params.dpi}dpi.png`
        : `plaque_${b.w}x${b.h}mm_${params.dpi}dpi.png`)
    : `dither_${params.algo}_${params.wmm}x${params.hmm}mm_${params.dpi}dpi.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

/* customer mockup: material + engraved-look burn, downsampled to a clean
   screen resolution — the smooth "how it will look" picture */
$('btnMockup').onclick = () => {
  if (!state.out) return;
  const c = contentPx();
  const MAX = 1600;
  const k = Math.min(1, MAX/Math.max(c.cw, c.ch));
  const mw = Math.max(1, Math.round(c.cw*k));
  const mh = Math.max(1, Math.round(c.ch*k));
  const out = document.createElement('canvas');
  out.width = mw; out.height = mh;
  const ox = out.getContext('2d');
  drawMaterialBg(ox, params.material, mw, mh, params.materialLandscape);
  ox.imageSmoothingEnabled = true;
  ox.imageSmoothingQuality = 'high';
  ox.drawImage(makeBurnLayer(true), c.ox*k, c.oy*k, c.W*k, c.H*k);
  // engraved text on top, in the material's burn colour
  const mat = MATERIALS[params.material], bc = hexToRgb(mat.burn);
  paintBurnText(ox, k, `rgba(${bc.r},${bc.g},${bc.b},${mat.alpha/255})`);
  if (params.boardOn && params.boardRound){
    // punch the disc out of the finished plaque (soft edge), then drop a white
    // studio background behind it — JPEG has no alpha to leave the corners on
    ox.globalCompositeOperation = 'destination-in';
    ox.beginPath();
    ox.ellipse(mw/2, mh/2, mw/2, mh/2, 0, 0, Math.PI*2);
    ox.fill();
    ox.globalCompositeOperation = 'destination-over';
    ox.fillStyle = '#ffffff';
    ox.fillRect(0, 0, mw, mh);
    ox.globalCompositeOperation = 'source-over';
  }
  try {
    out.toBlob(b => {
      if (!b){ alert('Mockup export failed.'); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = `mockup_${params.material}_${params.wmm}x${params.hmm}mm.jpg`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, 'image/jpeg', 0.92);
  } catch(err){
    alert('Mockup export failed: '+err.message);
  }
};

/* insert a pHYs chunk right after IHDR so the PNG carries real DPI */
let crcTable = null;
function crc32(bytes){
  if (!crcTable){
    crcTable = new Uint32Array(256);
    for (let n=0;n<256;n++){
      let c=n;
      for (let k=0;k<8;k++) c = (c&1) ? 0xEDB88320 ^ (c>>>1) : c>>>1;
      crcTable[n]=c>>>0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i=0;i<bytes.length;i++)
    crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc>>>8);
  return (crc ^ 0xFFFFFFFF)>>>0;
}
function insertPngDpi(png, dpi){
  const ppm = Math.round(dpi/0.0254);
  const chunk = new Uint8Array(4+4+9+4);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);                       // length
  chunk.set([0x70,0x48,0x59,0x73], 4);      // "pHYs"
  dv.setUint32(8, ppm);                     // x ppm
  dv.setUint32(12, ppm);                    // y ppm
  chunk[16] = 1;                            // unit: metre
  dv.setUint32(17, crc32(chunk.subarray(4,17)));
  const insertAt = 8 + 8 + 13 + 4;          // signature + IHDR chunk
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, insertAt), 0);
  out.set(chunk, insertAt);
  out.set(png.subarray(insertAt), insertAt + chunk.length);
  return out;
}

/* ---------------- collapsible sidebar sections ---------------- */
const SEC_KEY = 'ditherStudio.closedSections';
(function initSections(){
  const title = sec => sec.querySelector('h2').textContent;
  let closed = null;
  try { closed = JSON.parse(localStorage.getItem(SEC_KEY) || 'null'); } catch(e){}
  if (!Array.isArray(closed))
    closed = ['Board / workpiece', 'Crop', 'Adjustments', 'Enhance (unsharp mask)'];
  document.querySelectorAll('#sidebar .sec').forEach(sec => {
    if (closed.includes(title(sec))) sec.classList.add('closed');
    sec.querySelector('h2').addEventListener('click', () => {
      sec.classList.toggle('closed');
      const now = [...document.querySelectorAll('#sidebar .sec.closed')].map(title);
      try { localStorage.setItem(SEC_KEY, JSON.stringify(now)); } catch(e){}
    });
  });
})();

$('exportAlpha').onchange = e => { params.exportAlpha = e.target.checked; };

/* browsers restore checkbox state across a reload — take the DOM as truth */
params.boardRound = $('boardRound').checked;
params.exportAlpha = $('exportAlpha').checked;
syncBoardShape();
updateInfo();
