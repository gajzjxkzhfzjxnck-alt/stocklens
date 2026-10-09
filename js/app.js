// StockLens v2 前端：左侧股票列表 + 研究台 / 对话库 / 对话详情 / 股票页（hash 路由）
(function () {
  'use strict';

  // ── 工具 ────────────────────────────────────────────────
  const $ = s => document.querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  async function api(url, opt) {
    const r = await fetch(url, opt);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }
  const send = (method, url, body) => api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const RT = { buy: '买入', watch: '观察', neutral: '中性', avoid: '回避' };
  const ZN = { small: '合理建仓', medium: '黄金买点', heavy: '终极防御' };
  const fmt = n => n == null || isNaN(n) ? '—' : (Math.abs(n) >= 1 ? Number(n).toFixed(2) : Number(n).toFixed(3));
  const pct = n => (n > 0 ? '+' : '') + Number(n).toFixed(1) + '%';
  const rt = r => r ? `<span class="rt ${r}">${RT[r]}</span>` : '<span class="sub">未评级</span>';
  const tk = (s, link = true) => link ? `<a class="tk" href="#s-${encodeURIComponent(s)}">${esc(s)}</a>` : `<span class="tk">${esc(s)}</span>`;
  const local = ts => ts ? (/Z$|[+-]\d\d:\d\d$/.test(ts) ? new Date(ts).toLocaleString('sv-SE').replace(' ', 'T') : ts) : '';
  const day = ts => local(ts).slice(0, 10);
  const md = ts => local(ts).slice(5, 10);
  const mdSlash = ts => md(ts).replace('-', '/');
  const daysSince = ts => ts ? Math.floor((Date.now() - new Date(local(ts).slice(0, 10) + 'T00:00:00')) / 864e5) : null;
  const cleanReason = r => String(r).replace(/💰\s*/g, '').trim();
  const cut = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
  const updown = n => n > 0 ? 'up' : n < 0 ? 'down' : '';
  function ago(ts) {
    if (!ts) return '尚未运行';
    const m = Math.round((Date.now() - new Date(local(ts))) / 6e4);
    if (m < 1) return '刚刚'; if (m < 60) return `${m} 分钟前`;
    const h = Math.round(m / 60); if (h < 24) return `${h} 小时前`;
    return `${Math.round(h / 24)} 天前`;
  }
  let toastT;
  function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2600); }
  function copy(text) {
    try {
      navigator.clipboard.writeText(text).then(() => toast('已复制，粘贴到 Claude Code 即可继续讨论'), () => toast('复制失败，请手动复制'));
    } catch { toast('复制失败，请手动复制'); }
  }

  // ── 状态 ────────────────────────────────────────────────
  const S = { stocks: [], convs: [], followups: [], feed: [], status: null, sideFilter: 'all', feedFilter: 'all', libTab: 'kept', libSym: null, libQ: '', libHits: null, stab: {} };
  const bySym = () => Object.fromEntries(S.stocks.map(s => [s.symbol, s]));
  const tracked = s => !!s.position || !!s.followed || s.report_count > 0 || s.conv_count > 0 || (s.targets && s.targets.mine != null) || !!s.manual_rating;
  const hit = s => !!(s.scan && (s.scan.reasons || []).some(r => r.includes('💰')));
  const lastAct = s => [s.last_report_at, local(s.last_conv_at)].filter(Boolean).sort().pop() || s.added_at || '';
  function convSummaryFor(sym) {
    for (const c of S.convs) {
      if (c.status !== 'archived') continue;
      const s = (c.summary || []).find(x => x.symbol === sym);
      if (s) return { conv: c, s };
    }
    return null;
  }

  async function loadAll() {
    const [stocks, convs, followups, feed, status, portfolio] = await Promise.all([
      api('/api/stocks'), api('/api/conversations'), api('/api/followups'), api('/api/feed?limit=60'), api('/api/conversations/status'), api('/api/portfolio'),
    ]);
    Object.assign(S, { stocks, convs, followups, feed, status, portfolio });
    renderSync(); renderSide();
  }

  // ── 同步状态 ─────────────────────────────────────────────
  function renderSync() {
    const st = S.status || {};
    const dot = $('#syncPill .dot');
    dot.className = 'dot' + (st.running || st.processing ? ' busy' : st.errors ? ' err' : '');
    if (window.STOCKLENS_STATIC) {
      dot.className = 'dot';
      $('#syncText').textContent = `只读版 · ${ago(st.published_at)}更新`;
      $('#syncPill').title = '这是自动发布到 GitHub 的只读版。修改请在本地 StockLens 里操作。';
      return;
    }
    if (st.logged_in === false) dot.className = 'dot err';
    $('#syncText').textContent = st.logged_in === false ? '需要登录 Claude' : st.running || st.processing ? '正在整理对话…' : `自动归档 · ${ago(st.last_sync_at)}`;
    $('#syncPill').title = `已归档 ${st.archived || 0} 段 · 跳过 ${st.skipped || 0} 段${st.errors ? ` · ${st.errors} 段出错` : ''}。点击立即检查。`;
  }
  $('#syncPill').addEventListener('click', async () => {
    await send('POST', '/api/conversations/sync');
    toast('开始检查新对话。正在进行的对话会在结束 10 分钟后归档');
    setTimeout(pollStatus, 1500);
  });
  async function pollStatus() {
    try {
      const st = await api('/api/conversations/status');
      const changed = !S.status || st.archived !== S.status.archived || st.skipped !== S.status.skipped || st.processing !== S.status.processing || st.errors !== S.status.errors;
      S.status = st; renderSync();
      if (changed) { await loadAll(); route(false); }
    } catch { /* 服务暂时不可用 */ }
  }
  setInterval(pollStatus, 30000);

  // ── 左侧股票列表 ─────────────────────────────────────────
  function renderSide() {
    const q = $('#sq').value.trim().toUpperCase();
    const cur = decodeURIComponent((location.hash.match(/^#s-(.+)$/) || [])[1] || '');
    let rows = S.stocks.filter(s => q ? (s.symbol.includes(q) || (s.name || '').toUpperCase().includes(q)) : tracked(s));
    if (S.sideFilter === 'conv') rows = rows.filter(s => s.conv_count > 0);
    if (S.sideFilter === 'hit') rows = rows.filter(hit);
    if (S.sideFilter === 'hold') rows = rows.filter(s => s.position);
    rows.sort((a, b) => lastAct(b).localeCompare(lastAct(a)));
    $('#scount').textContent = rows.length;
    $('#slist').innerHTML = rows.map(s => {
      const sc = s.scan || {};
      return `<a class="srow${s.symbol === cur ? ' on' : ''}" href="#s-${encodeURIComponent(s.symbol)}"><i class="rd ${s.latest_rating || ''}" title="${RT[s.latest_rating] || '未评级'}"></i><span class="nm"><b>${esc(s.symbol)}${s.position ? `<span class="flag h">${s.position.kind === 'watch' ? '观察仓' : '持仓'}</span>` : ''}${s.conv_count ? '<span class="flag c">对话</span>' : ''}${hit(s) ? '<span class="flag b">买点</span>' : ''}</b><small>${esc(s.name)}</small></span><span class="pr">${fmt(sc.current_price)}${sc.change_pct != null ? `<small class="${updown(sc.change_pct)}">${pct(sc.change_pct)}</small>` : ''}</span></a>`;
    }).join('') || '<p class="sub pad">没有匹配的股票</p>';
    const on = $('#slist .srow.on'); if (on && on.scrollIntoViewIfNeeded) on.scrollIntoViewIfNeeded(false);
  }
  $('#sq').addEventListener('input', renderSide);

  // ＋ 添加股票：只填代码，后端确认代码有效并带出公司名、拉一次最新价
  const addForm = $('#addForm'), addSym = $('#addSym'), addMsg = $('#addMsg');
  const addHint = addMsg.textContent;
  $('#addBtn').addEventListener('click', () => { addForm.hidden = !addForm.hidden; if (!addForm.hidden) { addMsg.textContent = addHint; addSym.focus(); } });
  $('#addCancel').addEventListener('click', () => { addForm.hidden = true; addSym.value = ''; });
  addForm.addEventListener('submit', async e => {
    e.preventDefault();
    const symbol = addSym.value.trim();
    if (!symbol) return;
    const go = $('#addGo');
    go.disabled = true; addMsg.textContent = `正在查找 ${symbol.toUpperCase()}…`;
    try {
      const st = await send('POST', '/api/stocks/add', { symbol });
      await loadAll();
      addForm.hidden = true; addSym.value = '';
      location.hash = '#s-' + encodeURIComponent(st.symbol);
      toast(st.existed ? `${st.symbol} 已在列表里` : `已添加 ${st.symbol} ${st.name}`);
    } catch (err) {
      addMsg.textContent = err.message;
    } finally { go.disabled = false; }
  });
  $$('[data-sf]').forEach(b => b.addEventListener('click', () => {
    S.sideFilter = b.dataset.sf; $$('[data-sf]').forEach(x => x.classList.toggle('on', x === b)); renderSide();
  }));

  // ── 持仓 ────────────────────────────────────────────────
  const money = n => n == null ? '—' : (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
  const LV = { hit: 0, near: 1, done: 2, ok: 3 };
  function posStatus(p) {
    const price = p.price, c = p.cap;
    if (!price || !c || !c.t1) return { cls: 'ok', text: '—' };
    const u = c.unconfirmed ? '（上限价未确认）' : '';
    if (price >= c.t3) return { cls: 'hit', text: `越过第三档 $${c.t3}：减到 30% 底仓${u}` };
    if (price >= c.t2) return { cls: 'hit', text: `越过第二档 $${c.t2}：减剩余的 1/2${u}` };
    if (price >= c.t1) return c.t1_done
      ? { cls: 'done', text: `第一档已执行 · 距第二档 $${c.t2} 还差 ${((c.t2 - price) / price * 100).toFixed(1)}%` }
      : { cls: 'hit', text: `已越过第一档 $${c.t1}：减 1/3${u}` };
    const d = (c.t1 - price) / price * 100;
    return { cls: d <= 5 ? 'near' : 'ok', text: `距第一档 $${c.t1} 还差 ${d.toFixed(1)}%${u}` };
  }
  const pnl = p => p.price != null && p.cost != null
    ? { v: (p.price - p.cost) * p.shares, pct: (p.price - p.cost) / p.cost * 100, mv: p.price * p.shares }
    : { v: null, pct: null, mv: null };
  const positionOf = sym => ((S.portfolio && S.portfolio.positions) || []).find(p => p.symbol === sym) || null;
  function commitmentsAll() {
    return ((S.portfolio && S.portfolio.positions) || [])
      .flatMap(p => (p.commitments || []).map(c => ({ ...c, symbol: p.symbol })))
      .sort((a, b) => (a.due || '').localeCompare(b.due || ''));
  }
  function commitRow(c) {
    const d = c.due ? Math.ceil((new Date(c.due + 'T23:59:59') - Date.now()) / 864e5) : null;
    const when = c.due ? `${mdSlash(c.due)} 前${d != null ? `（还有 ${d} 天）` : ''}` : '';
    return `<li><span><span class="tk">${esc(c.symbol)}</span> ${esc(c.text)}<span class="src ${d != null && d <= 7 ? 'late' : ''}">${when}</span></span></li>`;
  }

  function renderPortfolio() {
    const P = S.portfolio;
    const el = $('#v-portfolio');
    if (!P) { el.innerHTML = '<h1>持仓</h1><div class="panel empty">还没有导入持仓。</div>'; return; }
    const ps = P.positions.map(p => ({ ...p, ...pnl(p), st: posStatus(p) }));
    const mv = ps.reduce((n, p) => n + (p.mv || 0), 0);
    const cost = ps.reduce((n, p) => n + p.cost * p.shares, 0);
    const gain = mv - cost;
    const core = ps.filter(p => p.kind === 'core').length, watch = ps.length - core;
    ps.sort((a, b) => LV[a.st.cls] - LV[b.st.cls] || (b.mv || 0) - (a.mv || 0));
    const rows = ps.map(p => `<tr class="${p.kind === 'watch' ? 'watchrow' : ''}">
        <td><a class="tk" href="#s-${encodeURIComponent(p.symbol)}">${esc(p.symbol)}</a></td>
        <td class="n">${p.shares}</td><td class="n">${fmt(p.cost)}</td><td class="n">${fmt(p.price)}</td>
        <td class="n ${updown(p.pct)}">${p.pct != null ? pct(p.pct) : '—'}</td>
        <td class="n">${money(p.mv)}</td><td class="n">${p.mv ? (p.mv / mv * 100).toFixed(1) + '%' : '—'}</td>
        <td><span class="lvl ${p.st.cls}">${esc(p.st.text)}</span></td></tr>`).join('');
    el.innerHTML = `
      <h1>持仓</h1>
      <div class="sub">来源：${esc(P.source)} · 股价取自 StockLens 最近一次扫描</div>
      <div class="pf-tiles">
        <div class="panel"><span>股票市值</span><b>${money(mv)}</b></div>
        <div class="panel"><span>浮动盈亏</span><b class="${updown(gain)}">${gain >= 0 ? '+' : ''}${money(gain)}</b><span>${cost ? pct(gain / cost * 100) : ''}</span></div>
        <div class="panel"><span>持仓</span><b>${core} 正式 + ${watch} 观察</b></div>
        <div class="panel"><span>总资产（含现金，${mdSlash(P.as_of)} 你提供）</span><b>约 ${money(P.total_assets)}</b></div>
      </div>
      <div class="panel pf-wrap"><table class="pf-table"><tr><th>股票</th><th class="n">股数</th><th class="n">成本</th><th class="n">现价</th><th class="n">盈亏</th><th class="n">市值</th><th class="n">占股票</th><th>估值卖出线</th></tr>${rows}</table></div>
      <div class="grid" style="margin-top:22px">
        <div>
          <h2>你定下的规则</h2>
          <div class="panel side-list rule-list">${P.rules.map(r => `<div><b>${esc(r.title)}</b>${esc(r.text)}</div>`).join('')}</div>
          ${P.doctrine_html ? `<h2>投资框架</h2><div class="panel side-list"><details><summary style="cursor:pointer">选股标准、仓位规则、理想汽车复盘教训……（点开看全文）</summary><div class="md" style="margin-top:10px">${P.doctrine_html}</div></details></div>` : ''}
          <h2>已了结</h2>
          <div class="panel side-list rule-list">${P.exited.map(x => `<div><b>${esc(x.name)}（${esc(x.symbol)}）</b>${esc(x.text)}</div>`).join('')}</div>
        </div>
        <aside class="rail" style="position:static">
          <div class="panel todo"><h2>持仓待办 <em>按日期</em></h2><ul>${commitmentsAll().map(commitRow).join('') || '<p class="sub">暂时没有</p>'}</ul></div>
        </aside>
      </div>
      <p class="sub">点股票代码可以看它的证伪线（一级清仓 / 二级减半 / 三级观察）。股数和成本可以在股票页的“卖出线”里修改。</p>`;
  }

  // ── 研究台 ──────────────────────────────────────────────
  function staleList() {
    const out = [];
    for (const s of S.stocks.filter(tracked)) {
      const px = s.scan && s.scan.current_price;
      const cs = convSummaryFor(s.symbol);
      const convDate = cs ? day(cs.conv.started_at) : '';
      if (cs && cs.s.price_at_time && px && convDate >= (s.last_report_at || '').slice(0, 10)) {
        const d = (px - cs.s.price_at_time) / cs.s.price_at_time * 100;
        if (Math.abs(d) >= 15) { out.push({ s, score: Math.abs(d), why: `${mdSlash(cs.conv.started_at)} 对话时 ${fmt(cs.s.price_at_time)}，现在${d > 0 ? '高' : '低'}了 ${Math.abs(d).toFixed(0)}%`, val: pct(d), cls: updown(d), href: `#s-${s.symbol}` }); continue; }
      }
      const c = s.scan && s.scan.change_pct;
      const ds = daysSince(lastAct(s));
      if (c != null && Math.abs(c) >= 10) { out.push({ s, score: Math.abs(c), why: `上次研究后${c > 0 ? '涨' : '跌'}了 ${Math.abs(c).toFixed(1)}%，已 ${ds} 天`, val: pct(c), cls: updown(c), href: `#s-${s.symbol}` }); continue; }
      if (ds != null && ds >= 60) out.push({ s, score: ds / 10, why: `已 ${ds} 天没有复查`, val: `${ds} 天`, cls: '', href: `#s-${s.symbol}` });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  function feedItem(it) {
    if (it.kind === 'batch') {
      return `<div class="panel item" data-k="report"><div class="item-top"><span class="kind rep">报告</span><span class="mono">${md(it.date)}</span><span>AI 批量复查 · ${it.symbols.length} 只</span></div><h3>批量复查研究报告</h3><div class="row" style="margin-top:8px">${it.symbols.map(x => tk(x)).join('')}</div></div>`;
    }
    if (it.kind === 'report') {
      return `<a class="panel item" data-k="report" href="#s-${encodeURIComponent(it.symbol)}"><div class="item-top"><span class="kind rep">报告</span><span class="mono">${md(it.date)}</span>${tk(it.symbol, false)}${it.rating ? rt(it.rating) : ''}<span>${it.source === 'uploaded' ? '手动上传' : 'AI 生成'}</span></div><h3>${esc(it.title)}</h3>${it.summary ? `<p class="concl">${esc(cut(it.summary, 170))}</p>` : ''}</a>`;
    }
    const fu = (it.summary || []).reduce((n, s) => n + (s.followups || []).length, 0);
    return `<a class="panel item" data-k="conv" href="#c-${it.id}"><div class="item-top"><span class="kind conv">对话</span><span class="mono">${md(it.date)}</span>${(it.stocks || []).map(x => tk(x, false)).join('')}</div><h3>${esc(it.title)}</h3><p class="concl">${(it.summary || []).map(s => `<b>${esc(s.symbol)}</b> ${esc(cut(s.verdict, 120))}`).join('<br>')}</p><div class="item-foot"><span>${it.turn_count} 轮提问</span>${fu ? `<span>${fu} 项待跟进</span>` : ''}${it.tool_calls ? `<span>用了 ${it.tool_calls} 次工具</span>` : ''}</div></a>`;
  }

  function renderHome() {
    const st = S.status || {};
    const nTracked = S.stocks.filter(tracked).length;
    const hits = S.stocks.filter(s => tracked(s) && hit(s)).sort((a, b) => lastAct(b).localeCompare(lastAct(a)));
    const stale = staleList().slice(0, 6);
    const fus = S.followups.filter(f => !f.done).sort((a, b) => (b.conv_date || '').localeCompare(a.conv_date || '')).slice(0, 8);
    const now = new Date();
    const dstr = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 周${'日一二三四五六'[now.getDay()]}`;
    const items = S.feed.filter(it => S.feedFilter === 'all' || (S.feedFilter === 'conv' ? it.kind === 'conversation' : it.kind !== 'conversation'));
    $('#v-home').innerHTML = `
      <div class="home-head"><div><h1>研究台</h1><div class="sub">${dstr} · 关注 ${nTracked} 只 · 已归档 ${st.archived || 0} 段股票对话</div></div></div>
      <div class="panel pipe">
        <div class="pipe-l"><strong>你和 Claude 的股票讨论会自动出现在这里</strong>
          <span class="sub">对话结束 10 分钟后自动整理。上次检查 ${ago(st.last_sync_at)} · 已归档 ${st.archived || 0} 段 · 跳过 ${st.skipped || 0} 段非股票对话${st.errors ? ` · <a class="muted-link" href="#library">${st.errors} 段出错</a>` : ''}</span></div>
        <div class="steps"><i>对话结束</i><span class="arr">→</span><i>识别股票</i><span class="arr">→</span><i>生成结论与待跟进</i><span class="arr">→</span><i>挂到股票时间线</i></div>
      </div>
      <div class="grid">
        <div>
          <h2>最近动态</h2>
          <div class="filters" role="group" aria-label="筛选动态">
            ${[['all', '全部'], ['conv', '对话'], ['report', '报告']].map(([k, l]) => `<button data-ff="${k}" class="${S.feedFilter === k ? 'on' : ''}">${l}</button>`).join('')}
          </div>
          <div class="feed">${items.map(feedItem).join('') || '<div class="panel empty-home">还没有内容。在 Claude Code 里讨论一只股票，结束后会出现在这里。</div>'}</div>
        </div>
        <aside class="rail">
          ${S.portfolio ? `<div class="panel"><h2>持仓 · 卖出线 <em>${S.portfolio.positions.length}</em></h2><div class="alist">${S.portfolio.positions.map(p => ({ p, st: posStatus(p), g: pnl(p) })).sort((a, b) => ({ hit: 0, near: 1, done: 2, ok: 3 })[a.st.cls] - ({ hit: 0, near: 1, done: 2, ok: 3 })[b.st.cls]).map(({ p, st, g }) => `<a class="arow" href="#s-${encodeURIComponent(p.symbol)}"><span class="tk">${esc(p.symbol)}</span><span class="why"><span class="lvl ${st.cls}">${esc(st.text)}</span></span><span class="px ${updown(g.pct)}">${g.pct != null ? pct(g.pct) : '—'}</span></a>`).join('')}</div><a class="btn" href="#portfolio" style="margin-top:8px;width:100%;justify-content:center">查看持仓与证伪线</a></div>` : ''}
          <div class="panel"><h2>触及买点 <em>${hits.length}</em></h2><div class="alist">
            ${hits.slice(0, 8).map(s => { const r = (s.scan.reasons || []).find(x => x.includes('💰')); return `<a class="arow" href="#s-${encodeURIComponent(s.symbol)}"><span class="tk">${esc(s.symbol)}</span><span class="why">${esc(cleanReason(r).replace(/（现价[^）]*）|，现价.*$/, ''))}</span><span class="px">${fmt(s.scan.current_price)}</span></a>`; }).join('') || '<p class="sub" style="margin:0">暂时没有</p>'}
            ${hits.length > 8 ? `<button class="btn" id="allHits" style="margin-top:8px;width:100%">在左侧列表查看全部 ${hits.length} 只</button>` : ''}
          </div></div>
          <div class="panel"><h2>观点可能过时 <em>${stale.length}</em></h2><div class="alist">
            ${stale.map(x => `<a class="arow" href="${x.href}"><span class="tk">${esc(x.s.symbol)}</span><span class="why">${esc(x.why)}</span><span class="px ${x.cls}">${esc(x.val)}</span></a>`).join('') || '<p class="sub" style="margin:0">暂时没有</p>'}
          </div></div>
          <div class="panel todo"><h2>待跟进 <em>对话里提取</em></h2>
            ${fus.length ? `<ul>${fus.map(fuItem).join('')}</ul>` : '<p class="sub" style="margin:0">暂时没有</p>'}
          </div>
        </aside>
      </div>`;
    $$('[data-ff]').forEach(b => b.addEventListener('click', () => { S.feedFilter = b.dataset.ff; renderHome(); }));
    bindFollowups($('#v-home'));
    const ah = $('#allHits');
    if (ah) ah.addEventListener('click', () => { const b = $('[data-sf="hit"]'); b.click(); if (window.innerWidth <= 900) location.hash = '#stocks'; });
  }

  function fuItem(f) {
    return `<li><label><input type="checkbox" data-fu="${f.id}" ${f.done ? 'checked' : ''}><span class="${f.done ? 'done' : ''}"><span class="tk">${esc(f.symbol)}</span> ${esc(f.text)}<span class="src">${f.conv_date ? `<a href="#c-${f.conv_id}@${encodeURIComponent(f.symbol)}">来自 ${mdSlash(f.conv_date)} 对话</a>` : ''}</span></span></label></li>`;
  }
  function bindFollowups(root) {
    $$('[data-fu]', root).forEach(cb => cb.addEventListener('change', async () => {
      const f = await send('PATCH', `/api/followups/${cb.dataset.fu}`, { done: cb.checked });
      const i = S.followups.findIndex(x => x.id === f.id); if (i >= 0) S.followups[i] = { ...S.followups[i], ...f };
      cb.nextElementSibling.classList.toggle('done', f.done);
      toast(f.done ? '已标记完成' : '已恢复为待跟进');
    }));
  }

  // ── 对话库 ──────────────────────────────────────────────
  function monthKey(ts) { const d = day(ts); return d ? `${d.slice(0, 4)} 年 ${+d.slice(5, 7)} 月` : '未知日期'; }
  function statusPill(c) {
    if (c.status === 'processing') return '<span class="status-pill">生成摘要中</span>';
    if (c.status === 'error') return `<span class="status-pill err" title="${esc(c.error || '')}">出错</span>`;
    if (c.status === 'waiting') return '<span class="status-pill" title="在终端运行 claude auth login 登录后会自动处理">等待登录</span>';
    return '';
  }
  function renderLibrary() {
    const all = S.libHits || S.convs;
    const kept = all.filter(c => c.status === 'archived' || (c.status === 'processing' && c.manual === 'archive'));
    const skipped = all.filter(c => c.status === 'skipped' || c.status === 'error' || c.status === 'waiting' || (c.status === 'processing' && c.manual !== 'archive'));
    const symCount = {};
    S.convs.filter(c => c.status === 'archived').forEach(c => (c.stocks || []).forEach(s => { symCount[s] = (symCount[s] || 0) + 1; }));
    const chips = Object.entries(symCount).sort((a, b) => b[1] - a[1]).slice(0, 14);
    let list = S.libTab === 'kept' ? kept : skipped;
    if (S.libSym) list = list.filter(c => (c.stocks || []).includes(S.libSym));
    let lastM = '', rows = '';
    for (const c of list) {
      const m = monthKey(c.started_at);
      if (m !== lastM) { rows += `<div class="month">${m}</div>`; lastM = m; }
      if (S.libTab === 'kept') {
        const fu = (c.summary || []).reduce((n, s) => n + (s.followups || []).length, 0);
        rows += `<a class="lrow" href="#c-${c.id}"><span class="d">${md(c.started_at)}</span><div><div class="row" style="margin-bottom:4px">${(c.stocks || []).map(s => tk(s, false)).join('')}${statusPill(c)}</div><h3>${esc(c.title)}</h3><p>${(c.summary || []).map(s => `${esc(s.symbol)}：${esc(cut(s.verdict, 80))}`).join('　')}</p></div><span class="r">${c.turn_count} 轮${fu ? ` · ${fu} 项待跟进` : ''}</span></a>`;
      } else {
        const maybe = (c.mentioned || []).length ? '<span class="maybe">提到了股票</span>' : '';
        rows += `<div class="lrow"><span class="d">${md(c.started_at)}</span><div><h3><a href="#c-${c.id}">${esc(c.title)}</a> ${maybe}${statusPill(c)}</h3><p class="why-skip">${esc(c.status === 'error' ? '摘要生成失败：' + cut(c.error, 90) : c.skip_reason || '')}${(c.mentioned || []).length ? ` · 提到 ${c.mentioned.map(esc).join('、')}` : ''}</p></div>${c.status === 'error' ? `<button class="btn" data-act="resummarize" data-id="${c.id}">重试</button>` : `<button class="btn" data-act="archive" data-id="${c.id}">改为归档</button>`}</div>`;
      }
    }
    $('#v-library').innerHTML = `
      <h1>对话库</h1>
      <div class="sub">Claude Code 里的股票讨论都会自动存到这里，原始记录被 Claude Code 清理后也不会丢</div>
      <div class="lib-tools">
        <label class="search" for="q2"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="q2" placeholder="搜对话内容，例如“止损”“OUSD”“前瞻 PE”" value="${esc(S.libQ)}" autocomplete="off"></label>
        <div class="row">${chips.map(([s]) => `<button class="tk chipbtn${S.libSym === s ? ' on' : ''}" data-sym="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      </div>
      <div class="tabs" role="tablist"><button class="${S.libTab === 'kept' ? 'on' : ''}" data-tab="kept">已归档 ${kept.length}</button><button class="${S.libTab === 'skip' ? 'on' : ''}" data-tab="skip">已跳过 ${skipped.length}</button></div>
      ${S.libTab === 'skip' ? '<p class="why-skip" style="margin:12px 0">这些对话没有讨论股票，所以没有归档。判断错了的话，点“改为归档”就行。</p>' : ''}
      <div class="${S.libTab === 'skip' ? 'skip' : ''}">${rows || `<p class="sub" style="padding:20px 0">${S.libQ ? '没有找到包含这个词的对话' : '这里还没有对话'}</p>`}</div>`;
    const q2 = $('#q2');
    let t;
    q2.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        S.libQ = q2.value.trim();
        S.libHits = S.libQ ? await api('/api/conversations?q=' + encodeURIComponent(S.libQ)) : null;
        renderLibrary();
        const n = $('#q2'); n.focus(); n.setSelectionRange(n.value.length, n.value.length);
      }, 300);
    });
    $$('[data-tab]', $('#v-library')).forEach(b => b.addEventListener('click', () => { S.libTab = b.dataset.tab; renderLibrary(); }));
    $$('[data-sym]', $('#v-library')).forEach(b => b.addEventListener('click', () => { S.libSym = S.libSym === b.dataset.sym ? null : b.dataset.sym; renderLibrary(); }));
    $$('[data-act]', $('#v-library')).forEach(b => b.addEventListener('click', () => convAction(b.dataset.id, b.dataset.act)));
  }

  async function convAction(id, act) {
    try {
      await send('POST', `/api/conversations/${id}/${act}`);
      toast(act === 'skip' ? '已改为跳过' : '正在生成摘要，大约需要 1 分钟');
      await loadAll(); route(false);
      if (act !== 'skip') pollConv(id);
    } catch (e) { toast(e.message); }
  }
  function pollConv(id) {
    let n = 0;
    const iv = setInterval(async () => {
      n++;
      const c = await api(`/api/conversations/${id}`).catch(() => null);
      if (!c || c.status !== 'processing' || n > 60) { clearInterval(iv); await loadAll(); route(false); if (c && c.status === 'archived') toast('摘要已生成'); }
    }, 5000);
  }

  // ── 对话详情 ─────────────────────────────────────────────
  async function renderConv(id, focus, jumpTo) {
    const el = $('#v-conv');
    el.innerHTML = '<p class="sub">加载中…</p>';
    let c;
    try { c = await api(`/api/conversations/${id}`); } catch (e) { el.innerHTML = `<div class="panel empty">${esc(e.message)}</div>`; return; }
    const tools = t => Object.entries(t.tools || {});
    const nTools = t => tools(t).reduce((n, [, v]) => n + v, 0);
    // 从股票页进来：只看你问这只股票的那几轮
    const fs = focus ? (c.summary || []).find(s => s.symbol === focus) : null;
    const summaryList = fs ? [fs] : (c.summary || []);
    const turnsShown = fs && (fs.turns || []).length ? c.turns.filter(t => fs.turns.includes(t.n)) : c.turns;
    const others = fs ? (c.summary || []).filter(s => s !== fs).map(s => s.symbol) : [];
    const focusNote = fs ? `<div class="panel view" style="padding:10px 16px;margin-bottom:18px"><span class="sub">只显示你问 ${esc(fs.symbol)} 的 ${turnsShown.length} 轮。</span> <a class="muted-link" href="#c-${c.id}">查看整段对话（${c.turn_count} 轮${others.length ? `，还问了 ${others.map(esc).join('、')}` : ''}）</a></div>` : '';
    let head = `<div class="crumb">${fs ? `<a href="#s-${encodeURIComponent(fs.symbol)}">${esc(fs.symbol)}</a> / 对话` : '<a href="#library">对话库</a>'} / ${day(c.started_at)}</div>
      <div class="c-head"><h1>${esc((fs && fs.title) || c.title)}</h1>
        <div class="c-meta"><span class="mono">${local(c.started_at).replace('T', ' ').slice(0, 16)}</span><span>${fs ? turnsShown.length : c.turn_count} 轮提问</span>${c.tool_calls && !fs ? `<span>用了 ${c.tool_calls} 次工具</span>` : ''}<span class="row">${(fs ? [fs.symbol] : (c.stocks || [])).map(s => tk(s)).join('')}</span>${statusPill(c)}
          ${c.status === 'archived' ? `<button class="btn" data-ca="tags" style="padding:2px 10px;font-size:12.5px">改股票标签</button><button class="btn" data-ca="resummarize" style="padding:2px 10px;font-size:12.5px">重新生成摘要</button><button class="btn" data-ca="skip" style="padding:2px 10px;font-size:12.5px">改为跳过</button>` : ''}
        </div>
        <div id="tagForm"></div>
      </div>`;
    let sum = '';
    if (c.status === 'archived' && summaryList.length) {
      sum = focusNote + `<div class="panel sum"><div class="sum-h"><span>自动摘要 · 按你问的股票分开</span><span>每只股票只同步你问它的那几轮</span></div><div class="sum-cols${summaryList.length === 1 ? ' one' : ''}">${summaryList.map(s => `
        <div class="sum-col"><h3>${tk(s.symbol)}${esc(s.name || '')}${s.price_at_time ? `<span class="sub mono" style="font-weight:400">当时 ${fmt(s.price_at_time)}</span>` : ''}</h3>
          ${s.title && !fs ? `<p class="sub" style="margin:-4px 0 6px">${esc(s.title)}${(s.turns || []).length ? ` · 第 ${s.turns.join('、')} 轮` : ''} · <a class="muted-link" href="#c-${c.id}@${encodeURIComponent(s.symbol)}">只看这只</a></p>` : ''}
          ${s.verdict ? `<div class="lbl">结论</div><p class="verdict">${esc(s.verdict)}</p>` : '<p class="sub">这只股票是你手动加上的标签，还没有摘要。点“重新生成摘要”。</p>'}
          ${(s.basis || []).length ? `<div class="lbl">依据</div><ul>${s.basis.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
          ${(s.followups || []).length ? `<div class="lbl">待跟进</div><ul>${s.followups.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
          ${(s.key_figures || []).length ? `<div class="lbl">关键数据</div><div class="fig">${s.key_figures.map(k => `<div><span>${esc(k.label)}</span><b>${esc(k.value)}</b></div>`).join('')}</div>` : ''}
        </div>`).join('')}</div></div>`;
    } else if (c.status === 'skipped') {
      sum = `<div class="panel view"><p style="margin:0">这段对话没有归档：${esc(c.skip_reason || '不是股票研究')}。</p><div class="view-act"><button class="btn primary" data-ca="archive">改为归档并生成摘要</button></div></div>`;
    } else if (c.status === 'processing') {
      sum = '<div class="panel view"><p style="margin:0">正在生成摘要，大约需要 1 分钟…</p></div>';
      pollConv(c.id);
    } else if (c.status === 'error') {
      sum = `<div class="panel view"><p style="margin:0">摘要生成失败：${esc(c.error || '')}</p><div class="view-act"><button class="btn primary" data-ca="resummarize">重试</button></div></div>`;
    }
    const chat = turnsShown.length ? turnsShown.map((t, i) => `
      <div class="turn-u" id="turn-${t.n}"><div class="md">${t.q_html}</div></div>
      <div class="turn-a">
        ${nTools(t) ? `<button class="tools" data-tg="tl${i}">▸ 用了 ${nTools(t)} 次工具${t.interim_html ? '，查看过程' : ''}</button><div class="tools-list" id="tl${i}" hidden>${tools(t).map(([k, v]) => `${esc(k)} ×${v}`).join(' · ')}${t.interim_html ? `<div class="md interim">${t.interim_html}</div>` : ''}</div>` : ''}
        ${t.len ? `<div class="panel ans${t.len < 900 ? ' open' : ''}"><div class="fold md">${t.a_html}</div>${t.len < 900 ? '' : '<button class="more">展开完整回答</button>'}</div>` : ''}
      </div>`).join('') : `<p class="sub">${c.status === 'archived' ? '原文没有存档。' : '这段对话没有讨论股票，原文不保存。'}</p>`;
    const hiddenNote = c.hidden_turns && !fs ? `<p class="sub" style="margin:-4px 0 12px">只保存了讨论股票的 ${c.turn_count} 轮，另外 ${c.hidden_turns} 轮与股票无关（例如建网站），没有存下来。</p>` : '';
    el.innerHTML = head + sum + (c.status === 'archived' ? `<h2>对话原文</h2>${hiddenNote}<div class="chat">${chat}</div>` : '');
    // 从股票页点某个问题进来：滚到那一问，并短暂高亮
    if (jumpTo) {
      const target = document.getElementById(`turn-${jumpTo}`);
      if (target) { setTimeout(() => target.scrollIntoView({ block: 'start' }), 0); target.classList.add('flash'); setTimeout(() => target.classList.remove('flash'), 2000); }
    }
    $$('.more', el).forEach(b => b.addEventListener('click', () => { const a = b.closest('.ans'); a.classList.toggle('open'); b.textContent = a.classList.contains('open') ? '收起' : '展开完整回答'; }));
    $$('[data-tg]', el).forEach(b => b.addEventListener('click', () => { const x = document.getElementById(b.dataset.tg); x.hidden = !x.hidden; b.textContent = b.textContent.replace(/^[▸▾]/, x.hidden ? '▸' : '▾'); }));
    $$('[data-ca]', el).forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.ca;
      if (a !== 'tags') return convAction(c.id, a);
      $('#tagForm').innerHTML = `<form class="inline-form" id="tf"><span>股票代码，用逗号分开</span><input id="tagInput" value="${esc((c.stocks || []).join(', '))}"><button class="btn primary" type="submit">保存</button><button class="btn" type="button" id="tfCancel">取消</button></form>`;
      $('#tfCancel').onclick = () => { $('#tagForm').innerHTML = ''; };
      $('#tf').onsubmit = async e => {
        e.preventDefault();
        const stocks = $('#tagInput').value.split(/[,，\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
        await send('PATCH', `/api/conversations/${c.id}`, { stocks });
        toast('已更新股票标签'); await loadAll(); renderConv(c.id);
      };
    }));
  }

  // ── 股票页 ──────────────────────────────────────────────
  function zonesOf(st) {
    const t = st.targets || {};
    return ['small', 'medium', 'heavy'].map(k => t[k] && t[k].low != null && t[k].high != null && t[k].high >= t[k].low
      ? [Number(t[k].low), Number(t[k].high), (t[k].name && !/维持/.test(t[k].name)) ? t[k].name : ZN[k], k] : null).filter(Boolean);
  }
  function where(p, zs) {
    const inZ = zs.find(z => p >= z[0] && p <= z[1]);
    if (inZ) return `<b style="color:var(--buy)">现价在${esc(inZ[2])}区间</b>`;
    const top = zs.slice().sort((a, b) => b[1] - a[1])[0];
    if (p > top[1]) return `距${esc(top[2])}上沿 <b class="mono">${pct((top[1] - p) / p * 100)}</b>`;
    const nx = zs.filter(z => z[0] > p).sort((a, b) => a[0] - b[0])[0];
    return `<b style="color:var(--buy)">已低于${esc(nx[2])}下沿 ${nx[0]}</b>`;
  }
  function ladder(st) {
    const zs = zonesOf(st), mine = st.targets && st.targets.mine, p = st.scan && st.scan.current_price;
    const pts = [];
    zs.forEach(z => pts.push(z[0], z[1])); if (mine != null) pts.push(mine); if (p) pts.push(p);
    if (!zs.length && mine == null) return `<div class="panel ladder">${buyplanBar(st)}<p class="sub" style="margin:0">还没有设定三档买点。点“用 AI 更新三档买点”让 AI 查最新资料来定；你的买入价在下面“改买入价”里自己设。</p>${buyplanWhy(st)}</div>`;
    let lo = Math.min(...pts), hi = Math.max(...pts); const pad = (hi - lo) * 0.08 || hi * 0.1; lo = Math.max(0, lo - pad); hi += pad;
    const L = 24, R = 776, x = v => L + (v - lo) * (R - L) / (hi - lo);
    const raw = (hi - lo) / 5, mag = Math.pow(10, Math.floor(Math.log10(raw))), step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(v => v >= raw);
    const ops = { small: 0.45, medium: 0.85, heavy: 1 };
    let g = `<line x1="${L}" y1="50" x2="${R}" y2="50" stroke="var(--line)" stroke-width="2"/>`;
    zs.forEach(z => { g += `<rect x="${x(z[0]).toFixed(1)}" y="38" width="${Math.max(4, x(z[1]) - x(z[0])).toFixed(1)}" height="24" rx="3" fill="var(--buy)" opacity="${ops[z[3]]}"/>`; });
    const clampX = v => Math.min(Math.max(v, 60), 740).toFixed(1);
    const near = mine != null && p && Math.abs(x(mine) - x(p)) < 120;
    if (mine != null) g += `<line x1="${x(mine).toFixed(1)}" y1="30" x2="${x(mine).toFixed(1)}" y2="70" stroke="var(--watch)" stroke-width="2"/><text x="${clampX(x(mine))}" y="22" text-anchor="middle" font-size="12" fill="var(--watch)">我的买入价 ${mine}</text>`;
    if (p) g += `<line x1="${x(p).toFixed(1)}" y1="26" x2="${x(p).toFixed(1)}" y2="74" stroke="var(--ink)" stroke-width="2.5"/><circle cx="${x(p).toFixed(1)}" cy="50" r="5" fill="var(--ink)"/><text x="${clampX(x(p))}" y="${near ? 90 : 18}" text-anchor="middle" font-size="12.5" font-weight="600" fill="var(--ink)" font-family="var(--font-data)">现价 ${fmt(p)}</text>`;
    let ticks = '';
    for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) { if (near && Math.abs(x(t) - x(p)) < 40) continue; ticks += `<text x="${x(t).toFixed(1)}" y="90">${+t.toFixed(2)}</text>`; }
    g += `<g font-size="11" fill="var(--faint)" font-family="var(--font-data)" text-anchor="middle">${ticks}</g>`;
    const cap = zs.map(z => `<span><i class="sw" style="background:var(--buy);opacity:${ops[z[3]]}"></i>${esc(z[2])} ${z[0]}–${z[1]}</span>`).join('') + (p && zs.length ? `<span>${where(p, zs)}</span>` : '');
    return `<div class="panel ladder">${buyplanBar(st)}<svg viewBox="0 0 800 96" role="img" aria-label="买入计划价格刻度">${g}</svg><div class="ladder-cap">${cap}</div>${buyplanWhy(st)}</div>`;
  }

  // 三档买点：AI 更新按钮 + 上次更新时间/依据；“我的买入价”只能手动改
  const bpJobs = {};
  function buyplanBar(st) {
    const t = st.targets || {}, job = bpJobs[st.symbol];
    const when = t.updated_at ? `${mdSlash(t.updated_at)} ${t.source === 'ai-refresh' ? 'AI 更新' : '更新'}${t.price_at_refresh ? `，当时股价 ${fmt(t.price_at_refresh)}` : ''}` : '';
    const running = job && job.status === 'running';
    const btn = running
      ? `<button class="btn" disabled>AI 正在查资料…${job.searches ? `（已搜索 ${job.searches} 次）` : ''}</button>`
      : `<button class="btn" data-bp="refresh">用 AI 更新三档买点</button>`;
    const mineBtn = `<button class="btn" data-sa="mine">改我的买入价</button>`;
    const err = job && job.status === 'error' ? `<span class="sub" style="color:var(--avoid)">更新失败：${esc(job.error)}</span>` : '';
    return `<div class="view-top"><h2 style="margin:0">买入计划 · 现价在哪儿</h2><div class="row">${when ? `<span class="sub">三档买点：${esc(when)}</span>` : ''}${err}${btn}${mineBtn}</div></div>`;
  }
  function buyplanWhy(st) {
    const t = st.targets || {};
    if (!t.rationale) return '';
    return `<details style="margin-top:8px"><summary class="sub" style="cursor:pointer">查看 AI 定这三档的依据</summary><div class="md" style="margin-top:8px;font-size:13.5px;white-space:pre-wrap">${esc(t.rationale)}</div></details>`;
  }
  async function refreshBuyplan(sym) {
    try {
      const j = await send('POST', `/api/stocks/${encodeURIComponent(sym)}/buyplan/refresh`);
      bpJobs[sym] = j;
      toast('AI 开始查最新资料并重算三档买点，大约需要 2–5 分钟');
      if (curStock() === sym) renderStock(sym);
      const iv = setInterval(async () => {
        const s = await api(`/api/stocks/${encodeURIComponent(sym)}/buyplan/job`).catch(() => null);
        if (!s) return;
        bpJobs[sym] = s;
        if (s.status !== 'running') {
          clearInterval(iv);
          await loadAll();
          toast(s.status === 'done' ? `${sym} 的三档买点已更新` : `${sym} 更新失败：${s.error}`);
        }
        if (curStock() === sym) renderStock(sym);
      }, 5000);
    } catch (e) { toast(e.message); }
  }
  const curStock = () => decodeURIComponent((location.hash.match(/^#s-(.+)$/) || [])[1] || '');

  function timeline(st) {
    const items = [];
    if (st.scan && (st.scan.reasons || []).length) items.push({ d: st.scan.scanned_at, k: 's', h: '<span class="kind sys">扫描提醒</span>', b: `<p style="margin-top:6px">${esc(st.scan.reasons.map(cleanReason).join('；'))}</p>` });
    st.reports.forEach(r => items.push({ d: r.created_at, k: '', href: `/viewer.html?id=${r.id}`, h: `<span class="kind rep">报告</span>${r.rating ? rt(r.rating) : ''}<span class="sub">${r.source === 'uploaded' ? '手动上传' : 'AI 生成'}</span>`, b: `<h3>${esc(r.title)}</h3>` }));
    st.conversations.forEach(c => { const s = (c.summary || []).find(x => x.symbol === st.symbol) || {}; items.push({ d: local(c.started_at), k: 'c', href: `#c-${c.id}@${encodeURIComponent(st.symbol)}`, h: `<span class="kind conv">对话</span>${s.price_at_time ? `<span class="sub">当时股价 ${fmt(s.price_at_time)}</span>` : ''}`, b: `<h3>${esc(s.title || c.title)}</h3>${s.verdict ? `<p>结论：${esc(s.verdict)}</p>` : ''}` }); });
    items.sort((a, b) => (b.d || '').localeCompare(a.d || ''));
    if (!items.length) return '';
    return `<h2>时间线</h2><div class="tl">${items.map(i => { const tag = i.href ? 'a' : 'div'; return `<div class="tl-item ${i.k}"><div class="tl-date">${md(i.d)}</div><div class="tl-axis"></div><div class="tl-body"><${tag} class="panel tl-card"${i.href ? ` href="${i.href}"` : ''} style="display:block"><div class="row">${i.h}<span class="d-m">${md(i.d)}</span></div>${i.b}</${tag}></div></div>`; }).join('')}</div>`;
  }

  function overview(st) {
    const t = st.targets || {}, p = st.scan && st.scan.current_price, zs = zonesOf(st);
    const fus = st.followups || [];
    return ladder(st) + `<div class="s-grid"><div>${timeline(st) || '<p class="sub">还没有报告和对话。</p>'}</div><aside>
      <div class="panel side-list"><h2>关键数字</h2><dl class="kv num"><dt>现价</dt><dd class="mono">${fmt(p)}</dd>${t.mine != null ? `<dt>我的买入价</dt><dd class="mono">${t.mine}</dd>` : ''}${zs.map(z => `<dt>${esc(z[2])}</dt><dd class="mono">${z[0]}–${z[1]}</dd>`).join('')}<dt>报告 / 对话</dt><dd class="mono">${st.reports.length} / ${st.conversations.length}</dd></dl></div>
      <div class="panel side-list todo"><h2>待跟进</h2>${fus.length ? `<ul>${fus.map(f => fuItem({ ...f, conv_date: (S.convs.find(c => c.id === f.conv_id) || {}).started_at })).join('')}</ul>` : '<p class="sub" style="margin:0">暂时没有。对话里提到要跟进的事项会自动出现在这里。</p>'}</div>
    </aside></div>`;
  }

  function reportsTab(st) {
    const tools = `<div class="view-act" style="margin:0 0 14px"><a class="btn primary" href="/stock.html?symbol=${encodeURIComponent(st.symbol)}">生成新报告 / 上传报告</a></div>`;
    if (!st.reports.length) return tools + '<div class="panel empty">还没有这只股票的研究报告。</div>';
    return tools + `<div class="panel plist">${st.reports.map(r => `<div class="lrow"><span class="d">${r.created_at.slice(0, 10)}</span><div><div class="row" style="margin-bottom:2px">${r.rating ? rt(r.rating) : ''}<span class="sub">${r.source === 'uploaded' ? '手动上传' : 'AI 生成'}</span></div><h3>${esc(r.title)}</h3>${r.summary ? `<p>${esc(cut(r.summary.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"'), 140))}</p>` : ''}</div><a class="btn" href="viewer.html?id=${r.id}">打开报告</a></div>`).join('')}</div>`;
  }
  function convsTab(st) {
    if (!st.conversations.length) {
      const p = st.scan && st.scan.current_price;
      return `<div class="panel empty"><div>还没有关于 ${esc(st.symbol)} 的对话。</div><div class="sub">在 Claude Code 里讨论这只股票，对话结束后会自动出现在这里。</div><button class="btn primary" data-copy="${esc(`帮我深度分析一下 ${st.symbol}（${st.name}）：${p ? `现价 ${fmt(p)}，` : ''}现在是好的买点吗？`)}">复制一个开场提问</button></div>`;
    }
    // 每段对话一张卡片，下面列出你问这只股票的每一个问题，点问题直接跳到那一问的回答
    return st.conversations.map(c => {
      const s = (c.summary || []).find(x => x.symbol === st.symbol) || {};
      const qs = c.questions || [];
      const href = `#c-${c.id}@${encodeURIComponent(st.symbol)}`;
      return `<div class="panel conv-card">
        <a class="conv-head" href="${href}"><span class="d">${day(c.started_at)}</span><div><h3>${esc(s.title || c.title)}</h3>${s.verdict ? `<p>${esc(s.verdict)}</p>` : ''}</div><span class="r">${qs.length || (s.turns || []).length || c.turn_count} 个问题${s.price_at_time ? ` · 当时 ${fmt(s.price_at_time)}` : ''}</span></a>
        ${qs.length ? `<ol class="qlist">${qs.map(q => `<li><a href="${href}~${q.n}"><span class="qt mono">${q.ts ? md(q.ts) + ' ' + local(q.ts).slice(11, 16) : ''}</span><span class="qq">${esc(q.q)}</span></a></li>`).join('')}</ol>` : ''}
      </div>`;
    }).join('');
  }
  function dataTab(st) {
    const sc = st.scan || {}, p = sc.current_price, zs = zonesOf(st), mine = st.targets && st.targets.mine;
    const zrows = zs.map(z => `<tr><td>${esc(z[2])}</td><td class="mono">${z[0]}–${z[1]}</td><td class="mono">${p ? (p >= z[0] && p <= z[1] ? '<span style="color:var(--buy)">在区间内</span>' : p < z[0] ? '<span style="color:var(--buy)">已低于</span>' : pct((z[1] - p) / p * 100)) : '—'}</td></tr>`).join('') + (mine != null ? `<tr><td>我的买入价</td><td class="mono">${mine}</td><td class="mono">${p ? pct((mine - p) / p * 100) : '—'}</td></tr>` : '');
    const hist = st.reports.filter(r => r.rating).slice().reverse();
    const figs = st.conversations.map(c => ({ c, s: (c.summary || []).find(x => x.symbol === st.symbol) })).filter(x => x.s && (x.s.key_figures || []).length);
    return `<div class="dgrid">
      <div class="panel"><h2>行情${sc.scanned_at ? ` · ${mdSlash(sc.scanned_at)} 扫描` : ''}</h2><dl class="kv num"><dt>现价</dt><dd class="mono">${fmt(p)} ${esc(sc.currency || '')}</dd><dt>较上次报告${sc.ref_date ? `（${mdSlash(sc.ref_date)}）` : ''}</dt><dd class="mono ${updown(sc.change_pct)}">${sc.change_pct != null ? pct(sc.change_pct) : '—'}</dd><dt>交易所</dt><dd>${esc(st.exchange)}</dd></dl>${(sc.reasons || []).length ? `<div class="lbl">扫描提醒</div><ul class="why-list">${sc.reasons.map(r => `<li>${esc(cleanReason(r))}</li>`).join('')}</ul>` : ''}${sc.error ? `<p class="sub">扫描出错：${esc(sc.error)}</p>` : ''}</div>
      <div class="panel"><h2>买点表</h2>${zrows ? `<div class="tbl-wrap"><table class="dtbl"><tr><th>档位</th><th>价格区间</th><th>现价距离</th></tr>${zrows}</table></div>` : '<p class="sub" style="margin:0">还没有设定买点</p>'}</div>
      <div class="panel"><h2>评级历史</h2>${hist.length ? `<div class="tbl-wrap"><table class="dtbl">${hist.map(r => `<tr><td class="mono">${r.created_at.slice(0, 10)}</td><td>${rt(r.rating)}</td><td class="sub">${r.source === 'uploaded' ? '手动上传报告' : 'AI 生成报告'}</td></tr>`).join('')}${st.manual_rating ? `<tr><td class="mono">手动</td><td>${rt(st.manual_rating)}</td><td class="sub">你设定的评级（优先）</td></tr>` : ''}</table></div>` : '<p class="sub" style="margin:0">还没有评级记录</p>'}</div>
      ${figs.map(({ c, s }) => `<div class="panel"><h2>对话里的数据 · ${mdSlash(c.started_at)}</h2><div class="fig">${s.key_figures.map(k => `<div><span>${esc(k.label)}</span><b>${esc(k.value)}</b></div>`).join('')}</div><p class="sub" style="margin:8px 0 0"><a class="muted-link" href="#c-${c.id}@${encodeURIComponent(st.symbol)}">${esc(s.title || c.title)}</a></p></div>`).join('')}
    </div>`;
  }

  // 我的判断：手写，停止输入 1 秒后自动保存；公网只读版只显示内容
  function myViewBox(st) {
    const v = st.my_view || {};
    const when = v.updated_at ? `已保存 · ${mdSlash(v.updated_at)} ${v.updated_at.slice(11, 16)}` : '还没写';
    if (window.STOCKLENS_STATIC) {
      return v.text ? `<div class="panel myview"><div class="view-top"><h2 style="margin:0">我的判断</h2><span class="sub">${esc(when.replace('已保存 · ', '更新于 '))}</span></div><div class="myview-text">${esc(v.text)}</div></div>` : '';
    }
    return `<div class="panel myview"><div class="view-top"><h2 style="margin:0"><label for="myView">我的判断</label></h2><span class="sub" id="myViewState">${esc(when)}</span></div>
      <textarea id="myView" rows="4" placeholder="写下你自己对 ${esc(st.symbol)} 的判断：为什么买 / 为什么不买、在等什么信号、什么情况下改主意……">${esc(v.text || '')}</textarea></div>`;
  }
  function bindMyView(el, sym) {
    const ta = $('#myView', el);
    if (!ta) return;
    const stateEl = $('#myViewState', el);
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.max(96, ta.scrollHeight + 2) + 'px'; };
    grow();
    let t, saving = Promise.resolve();
    const save = () => {
      const text = ta.value;
      saving = saving.then(() => send('PATCH', `/api/stocks/${encodeURIComponent(sym)}/view`, { text }))
        .then(r => { stateEl.textContent = `已保存 · ${mdSlash(r.updated_at)} ${r.updated_at.slice(11, 16)}`; })
        .catch(e => { stateEl.textContent = '保存失败：' + e.message; });
    };
    ta.addEventListener('input', () => { grow(); stateEl.textContent = '正在输入…'; clearTimeout(t); t = setTimeout(save, 1000); });
    ta.addEventListener('blur', () => { if (stateEl.textContent === '正在输入…') { clearTimeout(t); save(); } });
  }

  function posCard(p0, st) {
    const p = { ...p0, price: st.scan && st.scan.current_price };
    const g = pnl(p), ss = posStatus(p), T = S.portfolio && S.portfolio.total_assets;
    return `<div class="panel pos-card">
      <div><span>${p.kind === 'watch' ? '观察仓' : '正式持仓'}</span><b>${p.shares} 股</b></div>
      <div><span>成本</span><b>${fmt(p.cost)}</b></div>
      <div><span>浮动盈亏</span><b class="${updown(g.pct)}">${g.v != null ? (g.v >= 0 ? '+' : '') + money(g.v) : '—'}</b><span class="${updown(g.pct)}">${g.pct != null ? pct(g.pct) : ''}</span></div>
      <div><span>市值${T ? ' / 占总资产约' : ''}</span><b>${money(g.mv)}</b>${T && g.mv ? `<span>${(g.mv / T * 100).toFixed(1)}%</span>` : ''}</div>
      <div><span>估值卖出线</span><span class="lvl ${ss.cls}">${esc(ss.text)}</span><button class="muted-link" data-go="sell" style="border:0;background:none;padding:4px 0 0">看证伪线 →</button></div>
    </div>`;
  }

  function sellTab(p0) {
    const st = S.stocks.find(s => s.symbol === p0.symbol) || {};
    const p = { ...p0, price: st.scan && st.scan.current_price }, c = p.cap || {}, price = p.price;
    const dist = v => price ? pct((v - price) / price * 100) : '—';
    const row = (name, v, act, done) => `<tr><td>${name}</td><td class="mono">$${v}</td><td>${act}</td><td class="mono">${done ? '<span style="color:var(--buy)">已执行</span>' : price >= v ? '<span style="color:var(--avoid)">已越过</span>' : dist(v)}</td></tr>`;
    const list = (arr, cls, title, sub) => `<div class="panel ${cls}"><h3>${title}<span class="sub" style="font-weight:400">${sub}</span></h3>${arr.length ? `<ul>${arr.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="sub" style="margin:0">没有写</p>'}</div>`;
    const capTable = c.t1
      ? `<div class="tbl-wrap"><table class="dtbl"><tr><th>档位</th><th>价格</th><th>动作</th><th>距现价</th></tr>${row('上限价', c.cap, '不动作（留 10% 缓冲）')}${row('第一档', c.t1, '减 1/3', !!c.t1_done)}${row('第二档', c.t2, '减剩余的 1/2')}${row('第三档', c.t3, '减到 30% 底仓，永不归零')}</table></div><p class="sub" style="margin:8px 0 0">${esc(c.note || '')}${c.t1_done ? ' · ' + esc(c.t1_done) : ''}</p>`
      : '<p class="sub" style="margin:0">没有设定</p>';
    return `
      <div class="panel view"><div class="view-top"><h2 style="margin:0">持仓论点</h2><span class="sub">${p.kind === 'watch' ? '观察仓' : '正式持仓'}</span></div><p style="margin:0">${esc(p.thesis || '')}</p>
        <p class="sub" style="margin:10px 0 0">证伪线触发时直接执行：不重新论证、不等下一个财报、不看股价是否已经跌了很多。</p></div>
      <h2>基本面证伪线</h2>
      <div class="lines">
        ${list(p.l1 || [], 'l1', '一级 · 清仓线', '触发任一，减 70–100%')}
        ${list(p.l2 || [], 'l2', '二级 · 减半线', '触发任一，减 30–50%')}
        ${list(p.l3 ? [p.l3] : [], 'l3', '三级 · 观察线', '满足时不动仓')}
      </div>
      <div class="dgrid" style="margin-top:18px">
        <div class="panel"><h2>估值卖出线（9% 贴现）</h2>${capTable}</div>
        <div class="panel todo"><h2>加仓规则 · 待办 · 备注</h2><ul>
          ${(p.add_rules || []).map(x => `<li><span><b>加仓：</b>${esc(x)}</span></li>`).join('')}
          ${(p.commitments || []).map(c2 => commitRow({ ...c2, symbol: p.symbol })).join('')}
          ${(p.notes || []).map(x => `<li><span class="sub">${esc(x)}</span></li>`).join('')}
        </ul></div>
      </div>
      <form class="inline-form" id="posForm" style="margin-top:18px"><label for="posShares">股数</label><input id="posShares" type="number" step="any" value="${p.shares}"><label for="posCost">成本</label><input id="posCost" type="number" step="any" value="${p.cost}"><button class="btn primary" type="submit">保存</button><span class="sub">买卖之后在这里改一下</span></form>`;
  }

  async function renderStock(sym) {
    const el = $('#v-stock');
    // 正在写“我的判断”或填改价/改评级表单时不重绘，免得把没保存的内容冲掉
    const ae = document.activeElement;
    if (ae && !el.hidden && el.contains(ae) && (ae.id === 'myView' || ae.closest('.inline-form'))) return;
    let st;
    try { st = await api(`/api/stocks/${encodeURIComponent(sym)}`); } catch (e) { el.innerHTML = `<div class="panel empty">没有找到 ${esc(sym)}。</div>`; return; }
    const tab = S.stab[sym] || 'ov';
    const sc = st.scan || {};
    const hist = st.reports.filter(r => r.rating).slice().reverse().map(r => `${RT[r.rating]}（${mdSlash(r.created_at)}）`).filter((v, i, a) => i === 0 || a[i - 1].slice(0, 2) !== v.slice(0, 2));
    const head = `<div class="crumb"><a href="#home">研究台</a> / ${esc(st.symbol)}</div>
      <div class="s-head"><div><div class="row" style="margin-bottom:6px">${tk(st.symbol, false)}<span class="sub">${esc(st.exchange)}${st.ai_layer_label ? ' · ' + esc(st.ai_layer_label) : ''}</span>${rt(st.latest_rating)}${st.manual_rating ? '<span class="sub">手动评级</span>' : ''}<button class="muted-link" data-sa="rating" style="border:0;background:none;padding:0 4px">改评级</button></div><h1>${esc(st.name)}</h1><div class="sub">${hist.length ? '评级：' + hist.join(' → ') + ' · ' : ''}${st.reports.length} 份报告 · ${st.conversations.length} 段对话${st.conversations.length ? ` · ${st.conversations.reduce((n, c) => n + (c.questions || []).length, 0)} 个问题` : ''}</div></div>
      <div class="px"><div class="big">${fmt(sc.current_price)} <span class="sub mono" style="font-size:13px">${esc(sc.currency || '')}</span></div><div class="sub">${sc.change_pct != null ? `较 ${mdSlash(sc.ref_date)} 报告 <span class="mono ${updown(sc.change_pct)}">${pct(sc.change_pct)}</span> · ` : ''}${sc.scanned_at ? `${mdSlash(sc.scanned_at)} ${sc.scanned_at.slice(11, 16)} 扫描` : '还没有扫描'} · <button class="muted-link" data-sa="scan" style="border:0;background:none;padding:0">重新扫描</button></div></div></div>
      <div id="saForm" style="margin:-8px 0 16px"></div>`;
    const pos = positionOf(st.symbol);
    const tabs = [['ov', '概览'], ...(pos ? [['sell', '卖出线']] : []), ['rep', '报告', st.reports.length], ['conv', '对话', st.conversations.length], ['data', '数据']];
    const body = tab === 'sell' && pos ? sellTab(pos) : tab === 'rep' ? reportsTab(st) : tab === 'conv' ? convsTab(st) : tab === 'data' ? dataTab(st) : myViewBox(st) + (pos ? posCard(pos, st) : '') + overview(st);
    el.innerHTML = head + `<div class="stabs" role="tablist">${tabs.map(t => `<button data-stab="${t[0]}" class="${t[0] === tab ? 'on' : ''}">${t[1]}${t[2] != null ? `<em>${t[2]}</em>` : ''}</button>`).join('')}</div>` + body;
    $$('[data-stab]', el).forEach(b => b.addEventListener('click', () => { S.stab[sym] = b.dataset.stab; renderStock(sym); }));
    $$('[data-copy]', el).forEach(b => b.addEventListener('click', () => copy(b.dataset.copy)));
    bindFollowups(el);
    $$('[data-sa]', el).forEach(b => b.addEventListener('click', () => stockAction(st, b.dataset.sa, b)));
    bindMyView(el, st.symbol);
    $$('[data-bp]', el).forEach(b => b.addEventListener('click', () => refreshBuyplan(sym)));
    $$('[data-go]', el).forEach(b => b.addEventListener('click', () => { S.stab[sym] = b.dataset.go; renderStock(sym); }));
    const pf = $('#posForm', el);
    if (pf) pf.onsubmit = async e => { e.preventDefault(); try { await send('PATCH', `/api/portfolio/${encodeURIComponent(sym)}`, { shares: $('#posShares').value, cost: $('#posCost').value }); if (document.activeElement) document.activeElement.blur(); await loadAll(); renderStock(sym); toast('已更新持仓'); } catch (err) { toast('保存失败：' + err.message); } };
  }

  async function stockAction(st, a, btn) {
    // 表单出现在按钮所在的框里（改买入价 → 买入计划框），不再固定在页面顶部
    let box = $('#saForm');
    const panel = btn && btn.closest('.panel');
    if (panel) {
      box = panel.querySelector('.sa-slot');
      if (!box) { box = document.createElement('div'); box.className = 'sa-slot'; (panel.querySelector('.view-top') || panel.firstElementChild).after(box); }
    }
    if (a === 'scan') {
      toast('正在扫描行情…');
      try { await send('POST', `/api/stocks/${encodeURIComponent(st.symbol)}/scan`); await loadAll(); renderStock(st.symbol); toast('扫描完成'); } catch (e) { toast('扫描失败：' + e.message); }
      return;
    }
    if (a === 'rating') {
      box.innerHTML = `<form class="inline-form" id="saf"><label for="saRating">我的评级</label><select id="saRating"><option value="">跟随最新报告</option>${Object.entries(RT).map(([k, v]) => `<option value="${k}" ${st.manual_rating === k ? 'selected' : ''}>${v}</option>`).join('')}</select><button class="btn primary" type="submit">保存</button><button class="btn" type="button" id="safCancel">取消</button></form>`;
    } else {
      const mine = st.targets && st.targets.mine;
      box.innerHTML = `<form class="inline-form" id="saf"><label for="saMine">我的买入价</label><input id="saMine" type="number" step="any" inputmode="decimal" value="${mine != null ? mine : ''}" placeholder="留空表示不设"><button class="btn primary" type="submit">保存</button><button class="btn" type="button" id="safCancel">取消</button></form>`;
    }
    const field = $('#saMine') || $('#saRating');
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (field) { field.focus(); if (field.select) field.select(); }
    $('#safCancel').onclick = () => { box.innerHTML = ''; };
    $('#saf').onsubmit = async e => {
      e.preventDefault();
      try {
        if (a === 'rating') await send('PATCH', `/api/stocks/${encodeURIComponent(st.symbol)}/rating`, { rating: $('#saRating').value || null });
        else await send('PATCH', `/api/stocks/${encodeURIComponent(st.symbol)}/targets`, { mine: $('#saMine').value });
        if (document.activeElement) document.activeElement.blur();
        await loadAll(); renderStock(st.symbol); toast('已保存');
      } catch (err) { toast('保存失败：' + err.message); }
    };
  }

  // ── 全局搜索 ────────────────────────────────────────────
  const gq = $('#q'), gr = $('#gresults');
  function renderSearch() {
    const q = gq.value.trim(); if (!q) { gr.hidden = true; return; }
    const Q = q.toUpperCase();
    const stocks = S.stocks.filter(s => s.symbol.includes(Q) || (s.name || '').toUpperCase().includes(Q))
      .sort((a, b) => (b.symbol === Q) - (a.symbol === Q) || tracked(b) - tracked(a)).slice(0, 6);
    const lq = q.toLowerCase();
    const convs = S.convs.filter(c => c.status === 'archived' && [c.title, ...(c.summary || []).flatMap(s => [s.symbol, s.name, s.verdict, ...(s.basis || [])])].join(' ').toLowerCase().includes(lq)).slice(0, 6);
    gr.innerHTML = (stocks.length ? '<div class="gh">股票</div>' + stocks.map(s => `<a href="#s-${encodeURIComponent(s.symbol)}"><b class="mono">${esc(s.symbol)}</b><small>${esc(s.name)}</small></a>`).join('') : '')
      + (convs.length ? '<div class="gh">对话</div>' + convs.map(c => `<a href="#c-${c.id}">${esc(c.title)}<small>${md(c.started_at)}</small></a>`).join('') : '')
      + `<div class="gh">原文</div><a href="#library" data-fulltext="1">在全部对话原文里搜“${esc(q)}”</a>`;
    gr.hidden = false;
    $$('a', gr).forEach((a, i) => a.classList.toggle('sel', i === 0));
  }
  gq.addEventListener('input', renderSearch);
  gq.addEventListener('focus', renderSearch);
  gq.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const a = $('a.sel', gr) || $('a', gr); if (a) a.click(); }
    if (e.key === 'Escape') { gr.hidden = true; gq.blur(); }
  });
  gr.addEventListener('click', async e => {
    const a = e.target.closest('a'); if (!a) return;
    if (a.dataset.fulltext) { S.libQ = gq.value.trim(); S.libTab = 'kept'; S.libHits = await api('/api/conversations?q=' + encodeURIComponent(S.libQ)); if (location.hash === '#library') renderLibrary(); }
    gr.hidden = true; gq.value = '';
  });
  document.addEventListener('click', e => { if (!e.target.closest('.gsearch')) gr.hidden = true; });
  document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); gq.focus(); gq.select(); } });

  // ── 路由 ────────────────────────────────────────────────
  function route(scroll = true) {
    const h = decodeURIComponent((location.hash || '#home').slice(1));
    let v = h;
    if (/^s-/.test(h)) { v = 'stock'; renderStock(h.slice(2)); }
    else if (/^c-/.test(h)) { v = 'conv'; const [cid, rest] = h.slice(2).split('@'); const [csym, qn] = (rest || '').split('~'); renderConv(cid, csym || null, qn ? Number(qn) : null); }
    else if (h === 'library') renderLibrary();
    else if (h === 'portfolio') renderPortfolio();
    else if (h !== 'stocks') { v = 'home'; renderHome(); }
    document.body.classList.toggle('v-stocks', v === 'stocks');
    $$('[data-view]').forEach(s => { s.hidden = s.dataset.view !== v; });
    const n = v === 'conv' ? 'library' : v === 'stock' ? 'stocks' : v;
    $$('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === n));
    renderSide();
    if (scroll) window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', () => route());

  loadAll().then(() => route()).catch(e => { $('#v-home').innerHTML = `<div class="panel empty">加载失败：${esc(e.message)}。确认 StockLens 服务在运行。</div>`; });
})();
