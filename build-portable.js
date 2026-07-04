// Bundle the app back into one self-contained HTML file for sharing /
// copying to another PC. Run:  node build-portable.js
// Output: dist/dither-studio-portable.html
"use strict";
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;

let html = fs.readFileSync(path.join(ROOT, 'dither-studio.html'), 'utf8');

html = html.replace('<link rel="stylesheet" href="css/style.css">',
  () => '<style>\n' + fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8') + '</style>');

html = html.replace(/<script src="js\/(\w+)\.js"><\/script>/g,
  (m, name) => '<script>\n' + fs.readFileSync(path.join(ROOT, 'js', name + '.js'), 'utf8') + '</script>');

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', 'dither-studio-portable.html');
fs.writeFileSync(out, html);
console.log('wrote ' + out + ' (' + fs.statSync(out).size + ' bytes)');
