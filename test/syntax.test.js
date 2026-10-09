'use strict';
// NovaDM's own UI scripts are loaded by HTML pages, not required by any test: a syntax error in one
// would only show up as a blank panel in the running app. Compile each of them here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('UI and preload scripts compile', () => {
  const dirs = [path.join(__dirname, '..', 'src', 'ui'), path.join(__dirname, '..', 'src', 'main'), path.join(__dirname, '..', 'browser-extension')];
  let n = 0;
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const file = path.join(dir, f);
      assert.doesNotThrow(() => new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }), file);
      n++;
    }
  }
  assert.ok(n > 30);
});
