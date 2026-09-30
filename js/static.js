// 公网静态版：把 /api/* 请求映射到导出的 data/*.json，并关闭所有写操作
(function () {
  'use strict';
  window.STOCKLENS_STATIC = true;
  document.documentElement.classList.add('static');
  const base = new URL('.', document.currentScript.src).href.replace(/js\/$/, '');
  const realFetch = window.fetch.bind(window);
  const json = obj => Promise.resolve(new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const readOnly = () => Promise.resolve(new Response(JSON.stringify({ error: '公网版只能查看，请在本地 StockLens 里操作' }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
  const file = p => realFetch(base + 'data/' + p);
  let convCache = null;

  window.fetch = function (input, opt) {
    const url = typeof input === 'string' ? input : input.url;
    const method = ((opt && opt.method) || 'GET').toUpperCase();
    const m = url.match(/^\/api\/([^?]*)(?:\?(.*))?$/);
    if (!m) return realFetch(input, opt);
    if (method !== 'GET') return readOnly();
    const path = m[1], qs = new URLSearchParams(m[2] || '');
    let mm;
    if (path === 'stocks') return file('stocks.json');
    if ((mm = path.match(/^stocks\/([^/]+)\/buyplan\/job$/))) return json({ status: 'idle' });
    if ((mm = path.match(/^stocks\/([^/]+)$/))) return file('stocks/' + encodeURIComponent(decodeURIComponent(mm[1])) + '.json');
    if (path === 'conversations/status') return file('status.json');
    if (path === 'conversations') {
      const q = (qs.get('q') || '').toLowerCase();
      return (convCache ? Promise.resolve(convCache) : file('conversations.json').then(r => r.json()).then(l => (convCache = l)))
        .then(list => json(!q ? list : list.filter(c => [c.title, ...(c.summary || []).flatMap(s => [s.symbol, s.name, s.title, s.verdict, ...(s.basis || [])])].join(' ').toLowerCase().includes(q))));
    }
    if ((mm = path.match(/^conversations\/([^/]+)$/))) return file('conversations/' + mm[1] + '.json');
    if (path === 'followups') return file('followups.json');
    if (path === 'feed') return file('feed.json');
    if (path === 'portfolio') return file('portfolio.json');
    if (path === 'brief') return file('brief.json');
    if ((mm = path.match(/^reports\/(\d+)$/))) return file('reports/' + mm[1] + '.json');
    return Promise.resolve(new Response('{}', { status: 404 }));
  };
})();
