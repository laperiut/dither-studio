"use strict";
/* ---------------- materials ---------------- */
const MATERIALS = {
  wood:   {burn:'#3a220e', invert:false, alpha:235},
  slate:  {burn:'#d3d7da', invert:true,  alpha:225},
  acrylic:{burn:'#e9e9ee', invert:true,  alpha:215},
  leather:{burn:'#2a170a', invert:false, alpha:235},
  cork:   {burn:'#41260f', invert:false, alpha:230},
  glass:  {burn:'#f2f6f8', invert:true,  alpha:200},
  alu:    {burn:'#dde1e5', invert:true,  alpha:230},
  tile:   {burn:'#141414', invert:false, alpha:245},
};

const textureCache = {};
function materialTile(mat){
  if (textureCache[mat]) return textureCache[mat];
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  const rnd = mulberry32(42); // deterministic so the tile is seamless-ish & stable

  const noise = (amt) => {
    const d = x.getImageData(0,0,S,S), p = d.data;
    for (let i=0;i<p.length;i+=4){
      const n = (rnd()-0.5)*amt;
      p[i]+=n; p[i+1]+=n; p[i+2]+=n;
    }
    x.putImageData(d,0,0);
  };

  switch(mat){
    case 'wood': {
      x.fillStyle='#b3854f'; x.fillRect(0,0,S,S);
      for (let i=0;i<38;i++){
        const y0 = rnd()*S, amp = 2+rnd()*5, per = 40+rnd()*90;
        x.strokeStyle = `rgba(90,55,20,${0.08+rnd()*0.22})`;
        x.lineWidth = 0.5+rnd()*2.2;
        x.beginPath();
        for (let px=0; px<=S; px+=6)
          x.lineTo(px, y0 + Math.sin(px/per*2*Math.PI + rnd())*amp);
        x.stroke();
      }
      noise(18);
      break;
    }
    case 'slate': {
      x.fillStyle='#383b3f'; x.fillRect(0,0,S,S);
      noise(26);
      for (let i=0;i<6;i++){
        x.strokeStyle=`rgba(200,205,210,${0.03+rnd()*0.05})`;
        x.lineWidth=0.5+rnd()*8;
        x.beginPath();
        x.moveTo(rnd()*S, rnd()*S);
        x.lineTo(rnd()*S, rnd()*S);
        x.stroke();
      }
      break;
    }
    case 'acrylic': {
      const g = x.createLinearGradient(0,0,S,S);
      g.addColorStop(0,'#101014'); g.addColorStop(0.45,'#1c1c24');
      g.addColorStop(0.55,'#101014'); g.addColorStop(1,'#16161c');
      x.fillStyle=g; x.fillRect(0,0,S,S);
      break;
    }
    case 'leather': {
      x.fillStyle='#6f4526'; x.fillRect(0,0,S,S);
      noise(24);
      for (let i=0;i<220;i++){
        x.fillStyle=`rgba(40,20,8,${0.05+rnd()*0.12})`;
        x.beginPath();
        x.arc(rnd()*S, rnd()*S, 0.5+rnd()*1.8, 0, 7);
        x.fill();
      }
      break;
    }
    case 'cork': {
      x.fillStyle='#c9a56f'; x.fillRect(0,0,S,S);
      for (let i=0;i<420;i++){
        const light = rnd()>0.5;
        x.fillStyle = light ? `rgba(230,205,160,${0.2+rnd()*0.3})`
                            : `rgba(120,85,45,${0.15+rnd()*0.3})`;
        x.beginPath();
        x.ellipse(rnd()*S, rnd()*S, 1+rnd()*4, 0.6+rnd()*2.5, rnd()*3.14, 0, 7);
        x.fill();
      }
      noise(10);
      break;
    }
    case 'glass': {
      x.fillStyle='#dfe9ee'; x.fillRect(0,0,S,S);
      x.globalAlpha=0.35;
      for (let i=-S;i<S*2;i+=48){
        const g=x.createLinearGradient(i,0,i+30,S);
        g.addColorStop(0,'rgba(255,255,255,0)');
        g.addColorStop(0.5,'rgba(255,255,255,0.7)');
        g.addColorStop(1,'rgba(255,255,255,0)');
        x.fillStyle=g;
        x.save(); x.translate(i,0); x.rotate(-0.5);
        x.fillRect(0,-S,26,S*3); x.restore();
      }
      x.globalAlpha=1;
      noise(6);
      break;
    }
    case 'alu': {
      x.fillStyle='#1b1d21'; x.fillRect(0,0,S,S);
      for (let y=0;y<S;y++){
        x.fillStyle=`rgba(255,255,255,${(rnd()*0.05).toFixed(3)})`;
        x.fillRect(0,y,S,1);
      }
      break;
    }
    case 'tile': {
      const g=x.createLinearGradient(0,0,S,S);
      g.addColorStop(0,'#f7f7f4'); g.addColorStop(1,'#e9e9e4');
      x.fillStyle=g; x.fillRect(0,0,S,S);
      noise(4);
      break;
    }
  }
  textureCache[mat]=c;
  return c;
}
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}

/* real material photos (backgrounds/ folder) — stretched to fit;
   procedural tiles above remain as the fallback for other materials
   or if the folder is missing */
const MATERIAL_PHOTOS = {
  wood:  {src:WOOD_BG,  rotate:true},   // rotate 90° → horizontal grain
  slate: {src:SLATE_BG, rotate:false},
};
for (const cfg of Object.values(MATERIAL_PHOTOS)){
  const img = new Image();
  img.onload = () => { cfg.img = img; if (state.out) drawPreview(); };
  img.src = cfg.src;
}
function drawMaterialBg(ctx, mat, w, h){
  const ph = MATERIAL_PHOTOS[mat];
  if (ph && ph.img){
    if (ph.rotate){
      ctx.save();
      ctx.translate(w/2, h/2);
      ctx.rotate(Math.PI/2);
      ctx.drawImage(ph.img, -h/2, -w/2, h, w);
      ctx.restore();
    } else {
      ctx.drawImage(ph.img, 0, 0, w, h);
    }
  } else {
    ctx.fillStyle = ctx.createPattern(materialTile(mat), 'repeat');
    ctx.fillRect(0, 0, w, h);
  }
}

