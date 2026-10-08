import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const app=readFileSync(new URL('../../admin-dashboard/src/App.jsx',import.meta.url),'utf8');
const css=readFileSync(new URL('../../admin-dashboard/src/reference-pages.css',import.meta.url),'utf8');

test('mobile drawer never mounts a filtering backdrop across the navigation',()=>{
 assert.doesNotMatch(app,/<button\s+className="mobile-nav-backdrop"/);
 assert.match(app,/mobile-nav-open/);
 assert.match(css,/\.app\.app-v2\.mobile-nav-open>main\s*\{[^}]*opacity:[^;}]+!important/s);
 assert.match(css,/\.app\.app-v2>aside\.open\s*\{[^}]*z-index:1000!important/s);
});

test('mobile drawer can close via visible button, outside click, or Escape',()=>{
 assert.match(app,/className="mobile-sidebar-close"/);
 assert.match(app,/onClickCapture=\{menu\?e=>\{/);
 assert.match(app,/e\.stopPropagation\(\);setMenu\(false\)/);
 assert.match(app,/e\.key==='Escape'/);
 assert.match(app,/aria-expanded=\{menu\}/);
 assert.match(css,/\.app\.app-v2 \.mobile-sidebar-close\s*\{[^}]*display:flex!important/s);
});

test('mobile navigation keeps its scroll without background blur overlay',()=>{
 assert.match(css,/\.app\.app-v2>aside \.sidebar-scroll\s*\{[^}]*overflow-y:auto!important/s);
 assert.match(css,/\.app\.app-v2>aside\.open\s*\{[^}]*backdrop-filter:none!important/s);
 assert.match(css,/\.app\.app-v2>\.mobile-nav-backdrop\s*\{[^}]*display:none!important/s);
});
