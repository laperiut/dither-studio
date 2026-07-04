"use strict";
/* ---------------- dither kernels ---------------- */
const KERNELS = {
  floyd:     {d:16, k:[[1,0,7],[-1,1,3],[0,1,5],[1,1,1]]},
  jarvis:    {d:48, k:[[1,0,7],[2,0,5],[-2,1,3],[-1,1,5],[0,1,7],[1,1,5],[2,1,3],[-2,2,1],[-1,2,3],[0,2,5],[1,2,3],[2,2,1]]},
  stucki:    {d:42, k:[[1,0,8],[2,0,4],[-2,1,2],[-1,1,4],[0,1,8],[1,1,4],[2,1,2],[-2,2,1],[-1,2,2],[0,2,4],[1,2,2],[2,2,1]]},
  atkinson:  {d:8,  k:[[1,0,1],[2,0,1],[-1,1,1],[0,1,1],[1,1,1],[0,2,1]]},
  burkes:    {d:32, k:[[1,0,8],[2,0,4],[-2,1,2],[-1,1,4],[0,1,8],[1,1,4],[2,1,2]]},
  sierra:    {d:32, k:[[1,0,5],[2,0,3],[-2,1,2],[-1,1,4],[0,1,5],[1,1,4],[2,1,2],[-1,2,2],[0,2,3],[1,2,2]]},
  sierra2:   {d:16, k:[[1,0,4],[2,0,3],[-2,1,1],[-1,1,2],[0,1,3],[1,1,2],[2,1,1]]},
  sierralite:{d:4,  k:[[1,0,2],[-1,1,1],[0,1,1]]},
};

const BAYER8 = [
  [ 0,32, 8,40, 2,34,10,42],[48,16,56,24,50,18,58,26],
  [12,44, 4,36,14,46, 6,38],[60,28,52,20,62,30,54,22],
  [ 3,35,11,43, 1,33, 9,41],[51,19,59,27,49,17,57,25],
  [15,47, 7,39,13,45, 5,37],[63,31,55,23,61,29,53,21]];

const DOT8 = [ // clustered-dot halftone
  [24,10,12,26,35,47,49,37],[ 8, 0, 2,14,45,59,61,51],
  [22, 6, 4,16,43,57,63,53],[30,20,18,28,33,41,55,39],
  [34,46,48,36,25,11,13,27],[44,58,60,50, 9, 1, 3,15],
  [42,56,62,52,23, 7, 5,17],[32,40,54,38,31,21,19,29]];

/* serpentine error diffusion; mask==0 pixels are treated as fixed white */
function errorDiffuse(gray, W, H, mask, kernel){
  const {d, k} = kernel;
  const burn = new Uint8Array(W*H);
  for (let y=0; y<H; y++){
    const rtl = (y & 1) === 1;
    for (let i=0; i<W; i++){
      const x = rtl ? W-1-i : i;
      const idx = y*W + x;
      if (!mask[idx]) continue;
      const old = gray[idx];
      const isBurn = old < 128;
      if (isBurn) burn[idx] = 1;
      const err = old - (isBurn ? 0 : 255);
      for (let j=0; j<k.length; j++){
        const dx = rtl ? -k[j][0] : k[j][0];
        const nx = x+dx, ny = y+k[j][1];
        if (nx<0||nx>=W||ny>=H) continue;
        const nidx = ny*W+nx;
        if (!mask[nidx]) continue;
        gray[nidx] += err * k[j][2] / d;
      }
    }
  }
  return burn;
}

function orderedDither(gray, W, H, mask, matrix){
  const burn = new Uint8Array(W*H);
  for (let y=0; y<H; y++){
    const mrow = matrix[y & 7];
    for (let x=0; x<W; x++){
      const idx=y*W+x;
      if (!mask[idx]) continue;
      const t = (mrow[x & 7]+0.5)*255/64;
      if (gray[idx] < t) burn[idx]=1;
    }
  }
  return burn;
}

function thresholdDither(gray, W, H, mask){
  const burn = new Uint8Array(W*H);
  for (let i=0;i<gray.length;i++)
    if (mask[i] && gray[i] < 128) burn[i]=1;
  return burn;
}

/* ---------------- blur (3x box approx of gaussian) ---------------- */
function boxesForGauss(sigma, n){
  const wIdeal = Math.sqrt((12*sigma*sigma/n)+1);
  let wl = Math.floor(wIdeal); if (wl%2===0) wl--;
  const wu = wl+2;
  const m = Math.round((12*sigma*sigma - n*wl*wl - 4*n*wl - 3*n)/(-4*wl - 4));
  const sizes=[];
  for (let i=0;i<n;i++) sizes.push(i<m?wl:wu);
  return sizes;
}
function boxBlurH(src, dst, W, H, r){
  const iarr = 1/(r+r+1);
  for (let y=0;y<H;y++){
    const off=y*W;
    let acc = src[off]*(r+1);
    for (let j=0;j<r;j++) acc += src[off+Math.min(j,W-1)];
    for (let x=0;x<W;x++){
      acc += src[off+Math.min(x+r,W-1)] - src[off+Math.max(x-r-1,0)];
      dst[off+x] = acc*iarr;
    }
  }
}
function boxBlurV(src, dst, W, H, r){
  const iarr = 1/(r+r+1);
  for (let x=0;x<W;x++){
    let acc = src[x]*(r+1);
    for (let j=0;j<r;j++) acc += src[Math.min(j,H-1)*W+x];
    for (let y=0;y<H;y++){
      acc += src[Math.min(y+r,H-1)*W+x] - src[Math.max(y-r-1,0)*W+x];
      dst[y*W+x] = acc*iarr;
    }
  }
}
function gaussianBlur(arr, W, H, sigma){
  if (sigma <= 0) return arr.slice();
  const a = arr.slice(), b = new Float32Array(arr.length);
  const boxes = boxesForGauss(sigma, 3);
  for (const size of boxes){
    const r = (size-1)/2 | 0;
    boxBlurH(a, b, W, H, r);
    boxBlurV(b, a, W, H, r);
  }
  return a;
}

