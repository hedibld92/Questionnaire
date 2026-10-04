'use strict';
// Wraps src/app.html (the page content) into a complete document: public/index.html.
// Run it after every change to src/app.html:  node build.js
// It first checks that the field lists of server.js match the questions of src/app.html.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, 'src', 'app.html');

// Evaluates the questionnaire description (from "const YN" to the SECTIONS array) of src/app.html.
function readSections(src = fs.readFileSync(SRC, 'utf8')) {
  const m = /\nconst YN = [\s\S]*?\nconst SECTIONS = [\s\S]*?\n\];\n/.exec(src);
  if (!m) throw new Error('src/app.html : tableau SECTIONS introuvable.');
  return vm.runInNewContext(m[0] + '({ SECTIONS, PRES });');
}

// Returns the list of differences between the questions of src/app.html and the field lists of server.js.
function checkFields() {
  const { SECTIONS, PRES } = readSections();
  const server = require('./server.js');
  const found = { yn: [], sat: [], text: [], multi: [] };
  for (const s of SECTIONS) for (const it of s.items) {
    if (it.type === 'group') for (const sub of it.items) found[it.kind]?.push(sub.id);
    else found[it.type]?.push(it.id);
  }
  const expected = { yn: server.YN_FIELDS, sat: server.SAT_FIELDS, text: server.TEXT_FIELDS };
  const names = { yn: 'YN_FIELDS', sat: 'SAT_FIELDS', text: 'TEXT_FIELDS' };
  const errors = [];
  for (const k of Object.keys(expected)) {
    for (const id of found[k]) if (!expected[k].includes(id)) errors.push('« ' + id + ' » manque dans ' + names[k] + ' (server.js)');
    for (const id of expected[k]) if (!found[k].includes(id)) errors.push('« ' + id + ' » est dans ' + names[k] + ' (server.js) mais pas dans src/app.html');
  }
  if (found.multi.join() !== 'eval_presence') errors.push('server.js ne gère qu’une question à choix multiples : eval_presence');
  const pres = PRES.map(p => p[0]);
  if (pres.join() !== server.PRESENCE.join()) errors.push('PRESENCE (server.js) doit valoir [' + pres.join(', ') + ']');
  return errors;
}

function build() {
  const errors = checkFields();
  if (errors.length) {
    console.error('Les champs de server.js ne correspondent plus au questionnaire :\n  - ' + errors.join('\n  - '));
    process.exit(1);
  }
  let src = fs.readFileSync(SRC, 'utf8');
  const head = [];
  src = src.replace(/<title>[\s\S]*?<\/title>\s*/, m => { head.push(m.trim()); return ''; });
  src = src.replace(/<link rel="stylesheet"[^>]*>\s*/g, m => { head.push(m.trim()); return ''; });

  const reset = ':root{color-scheme:light;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}';
  const html = '<!doctype html>\n<html lang="fr">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<meta name="robots" content="noindex">\n'
    + head.join('\n') + '\n<style>' + reset + '</style>\n</head>\n<body>\n' + src + '</body>\n</html>\n';

  fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'public', 'index.html'), html);
  console.log('public/index.html (' + Math.round(html.length / 1024) + ' Ko)');
  return html;
}

if (require.main === module) build();
module.exports = { readSections, checkFields, build };
