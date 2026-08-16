// Regenerate js/backgrounds.js from the material photos in backgrounds/.
"use strict";
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const images = [
  ['MDF_BG', 'mdf.jpeg', 'image/jpeg'],
  ['BIRCH_BG', 'birch.jpg', 'image/jpeg'],
  ['RIMU_BG', 'rimu.jpg', 'image/jpeg'],
  ['SLATE_BG', 'slate.png', 'image/png'],
];

const lines = [
  '"use strict";',
  '/* Embedded material photos, generated from backgrounds/ by embed-backgrounds.js.',
  '   Keeping these as data URLs allows mockup export when opened via file://. */',
];

for (const [name, filename, mime] of images) {
  const file = path.join(ROOT, 'backgrounds', filename);
  const data = fs.readFileSync(file).toString('base64');
  lines.push(`const ${name} = 'data:${mime};base64,${data}';`);
}

const output = path.join(ROOT, 'js', 'backgrounds.js');
fs.writeFileSync(output, lines.join('\n') + '\n');
console.log(`wrote ${output}`);
