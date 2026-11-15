'use strict';
// 1.8.1 fixes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('REQ-303: only the Guard switch rows stretch their first span (1.8.0 pushed list titles right)', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/ui/panel.html'), 'utf8');
  assert.doesNotMatch(css, /(^|[}\s])\.srow>span:first-child\{flex:1/m, 'an unscoped rule stretches every row\'s icon');
  assert.match(css, /label\.srow>span:first-child\{flex:1;\}/);
});
