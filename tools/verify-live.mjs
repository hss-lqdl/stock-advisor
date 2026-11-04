// 线上静态验收：确认 GitHub Pages 上的产物与 v1.4.0 一致
const BASE = process.argv[2] || 'https://hss-lqdl.github.io/stock-advisor/';
const bust = (u) => u + (u.includes('?') ? '&' : '?') + 't=' + Date.now();

const FILES = [
  'index.html', 'manifest.webmanifest', 'sw.js', '.nojekyll',
  'style.css',
  'js/main.js', 'js/api.js', 'js/store.js', 'js/universe.js', 'js/mainline.js',
  'js/market.js', 'js/indicators.js', 'js/strategy.js', 'js/plan.js',
  'js/backtest.js', 'js/charts.js', 'js/ui.js', 'js/engine.js',
  'js/views/today.js', 'js/views/mainline.js', 'js/views/picks.js',
  'js/views/positions.js', 'js/views/settings.js',
  'icons/icon-192.png', 'icons/icon-512.png',
  'icons/maskable-512.png', 'icons/icon-1024.png',
];

let bad = 0;
for (const f of FILES) {
  try {
    const r = await fetch(bust(BASE + f));
    const buf = new Uint8Array(await r.arrayBuffer());
    const okHttp = r.status === 200;
    const okSize = f === '.nojekyll' ? buf.length === 0 : buf.length > 0;
    if (!okHttp || !okSize) bad++;
    console.log(
      (okHttp && okSize ? 'OK  ' : 'FAIL') +
      ` ${f.padEnd(26)} HTTP ${r.status}  ${buf.length} B`
    );
  } catch (e) {
    bad++;
    console.log(`FAIL ${f.padEnd(26)} ${e.message}`);
  }
}

// 关键内容核对
const sw = await (await fetch(bust(BASE + 'sw.js'))).text();
const swVer = (sw.match(/VERSION\s*=\s*'([^']+)'/) || [])[1] || '(未找到)';
console.log(`\nsw.js VERSION = ${swVer}`);
const precache = (sw.match(/PRECACHE|CORE_ASSETS/) ? 'yes' : 'no');
console.log(`sw.js 含预缓存清单: ${precache}`);

const strat = await (await fetch(bust(BASE + 'js/strategy.js'))).text();
console.log(`strategy.js 含 dragon 策略: ${strat.includes('dragon')}`);
console.log(`strategy.js 含 computeLeader: ${strat.includes('computeLeader')}`);
console.log(`strategy.js 含 STRATEGY_FILTERS: ${strat.includes('STRATEGY_FILTERS')}`);

const idx = await (await fetch(bust(BASE + 'index.html'))).text();
const absRefs = (idx.match(/(?:src|href)="\//g) || []).length;
console.log(`index.html 绝对路径引用数（应为 0）: ${absRefs}`);

const man = JSON.parse(await (await fetch(bust(BASE + 'manifest.webmanifest'))).text());
console.log(`manifest start_url=${man.start_url} scope=${man.scope} display=${man.display} icons=${(man.icons || []).length}`);

console.log(`\n结论: ${bad === 0 && absRefs === 0 ? '静态验收通过' : `有 ${bad} 个资源异常`}`);
process.exit(bad === 0 && absRefs === 0 ? 0 : 1);
