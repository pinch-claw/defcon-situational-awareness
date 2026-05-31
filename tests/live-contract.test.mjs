import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const livePath = path.join(root, 'functions', 'api', 'live.js');

assert.ok(fs.existsSync(livePath), 'Cloudflare Pages Function functions/api/live.js should exist');
const live = fs.readFileSync(livePath, 'utf8');

for (const needle of [
  'api.weather.gov',
  'stations/KLAS/observations/latest',
  'nvroads.com/map/mapIcons',
  'fetchTrafficLayer',
  'filterNearCorridor',
]) {
  assert.ok(live.includes(needle), `live API should include ${needle}`);
}

for (const needle of [
  '/api/live',
  'Live Data Sources',
  'Weather Now',
  'Road Intelligence',
  'Transit Ops',
  'SourceHealth',
]) {
  assert.ok(html.includes(needle), `dashboard should render ${needle}`);
}

console.log('live contract ok');
