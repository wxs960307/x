/* 回帖助手 v6 · 侧边栏面板
 * 所有事情都通过消息交给 background 做（那边才是引擎），这里只管显示和收输入。
 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

if (new URLSearchParams(location.search).get('full') === '1') document.body.classList.add('full');

/* ── 跟 background 说话 ── */
/* 带超时：后台 worker 睡死或崩掉的时候，回调可能永远不来。
 * 以前没有超时，按钮就会卡在「停止中…」再也不动 —— 加个兜底。 */
function call(type, extra, timeoutMs) {
  const ms = timeoutMs || 15000;
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('后台 ' + Math.round(ms / 1000) + ' 秒没回话'));
    }, ms);
    chrome.runtime.sendMessage(Object.assign({ type }, extra || {}), (resp) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp) return reject(new Error('后台没响应。到 chrome://extensions 点一下刷新，再打开这个面板'));
      if (!resp.ok) return reject(new Error(resp.error || '出错了'));
      resolve(resp.data);
    });
  });
}

/* 后台不说话的时候，状态直接从 storage 读 —— 面板自己就能判断停没停 */
async function readLpRaw() {
  try {
    const r = await chrome.storage.local.get('lp');
    return (r && r.lp) || null;
  } catch (e) { return null; }
}

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
}

/* 扩展要访问你的模型接口，得先拿到这个域名的权限。
 * DeepSeek 已经写在 manifest 里了，换别的服务商时这里会弹一次授权。 */
async function ensureHost(base) {
  if (!base) return true;
  let origin;
  try { origin = new URL(base).origin + '/*'; } catch (e) { return true; }
  try {
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch (e) {
    return false;
  }
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let lastBatchSig = '';
let lastLogTail = '';
let lastFolSig = '';   // 关注底账列表的签名，没变就不重画
let lastRepSig = '';   // 转推底账列表的签名，同理
let lastCfg = null;    // 最近一次拿到的配置（自动循环要用里面的接口地址去申请权限）
let lastSentToday = 0; // 顶部「今日 X / Y」里的 X，改上限时要单独重画这一格
let settingsOpen = false;

/* 参数区这几个框，用户动过之后就别再被后台配置盖回去。
 * 以前每 1.5 秒 refresh 一次就 fillPanelFromCfg 一次，字刚打完就被弹回原值，
 * 看着就是「能改，但改了不生效」。 */
const PARAM_IDS = ['aTab', 'aLimit', 'aPickMin', 'aPickMax',
  'aSessMin', 'aSessMax', 'aStepMin', 'aStepMax', 'aAwayMin', 'aAwayMax', 'aDaily',
  'aHuman', 'aScreen', 'aWin',
  'aFollow', 'aFollowDaily', 'aFollowMinScore', 'aFollowMaxReplies', 'aFollowMaxLikes',
  'aRepost', 'aRepostDaily', 'aQuote', 'aQuoteDaily', 'aQuoteMaxReplies'];
let paramsDirty = false;
PARAM_IDS.forEach((id) => {
  const el = $('#' + id);
  if (!el) return;
  const mark = () => { paramsDirty = true; };
  el.addEventListener('input', mark);
  el.addEventListener('change', mark);
});

/* 改「每轮抓几条」或「每轮怎么回」时，顺手把「挑几条」的范围跟着收一下 */
$('#aLimit').addEventListener('input', syncPickRange);
$('#aPickMin').addEventListener('change', syncPickRange);
$('#aPickMax').addEventListener('change', syncPickRange);

/* 成对的最小~最大：失焦时才纠正（打字过程中改值会打断输入） */
$('#aSessMin').addEventListener('change', () => fixPair('aSessMin', 'aSessMax', 1, 30, 30));
$('#aSessMax').addEventListener('change', () => fixPair('aSessMin', 'aSessMax', 1, 30, 30));
$('#aStepMin').addEventListener('change', () => fixPair('aStepMin', 'aStepMax', 20, 600, 900));
$('#aStepMax').addEventListener('change', () => fixPair('aStepMin', 'aStepMax', 20, 600, 900));
$('#aAwayMin').addEventListener('change', () => fixPair('aAwayMin', 'aAwayMax', 3, 240, 360));
$('#aAwayMax').addEventListener('change', () => fixPair('aAwayMin', 'aAwayMax', 3, 240, 360));

/* 高级里那几个数是"范围"，很难在脑子里换算成"一天到底能回多少"。
 * 这里按当前填的值算一遍写出来，改数字就跟着变 —— 不然「一段回 4~9 条、
 * 每批 1~3 条、走开 15~45 分钟」这堆区间，作者根本没法自己估产量。 */
function updateCalc() {
  const box = $('#advCalc');
  if (!box) return;
  const val = (id, d) => {
    const el = $('#' + id);
    return Math.round(+((el && el.value) || d)) || d;
  };
  const L = Math.min(30, Math.max(1, val('aLimit', 10)));
  const pLo = Math.min(L, Math.max(1, val('aPickMin', 1)));
  const pHi = Math.min(L, Math.max(pLo, val('aPickMax', 3)));
  const sLo = Math.max(1, val('aSessMin', 4));
  const sHi = Math.max(sLo, val('aSessMax', 9));
  const tLo = Math.max(20, val('aStepMin', 30));
  const tHi = Math.max(tLo, val('aStepMax', 70));
  const aLo = Math.max(3, val('aAwayMin', 15));
  const aHi = Math.max(aLo, val('aAwayMax', 45));
  const cap = Math.max(1, val('aDaily', 60));

  const perBatch = (pLo + pHi) / 2;          // 一批回几条（均值）
  const perSit = (sLo + sHi) / 2;            // 一段回几条（均值）
  const batches = Math.max(1, Math.round(perSit / perBatch));
  const posts = batches * L;
  /* 每条占的时间 = 滑到这条（条间隔）+ 读想打查。
   * 后面那 85 秒不是拍脑袋：60 字帖子读 11 秒、想 25 秒、
   * 30 字回复打 42 秒、发前检查 7 秒，跟 background 的 humanTiming 一致。 */
  const perReply = ((tLo + tHi) / 2 + 85) / 60;
  const sit = Math.max(1, Math.round(perSit * perReply));
  /* 走开时长是往上限偏的：U^(1/(1+2w)) 的期望 = 1/(1+1/(1+2w))。
   * 跟 background 的 pickAwayMin 用同一个式子，算出来才和实际跑的对得上。 */
  const w = Math.min(1, sit / 20);
  const eu = 1 / (1 + 1 / (1 + 2 * w));
  const away = Math.round(aLo + eu * (aHi - aLo));
  const perMin = perSit / (sit + away);      // 每分钟回几条
  const sixH = Math.round(perMin * 360);

  box.innerHTML =
    '按现在的数：一段约回 <b>' + Math.round(perSit) + '</b> 条，要翻 <b>' + batches +
    '</b> 批（<b>' + posts + '</b> 条帖子）；坐 <b>' + sit + '</b> 分钟、走开 <b>' + away +
    '</b> 分钟 → 6 小时约 <b>' + sixH + '</b> 条' +
    (sixH > cap ? '，<em>但会被每天 ' + cap + ' 条截住</em>' : '') + '。';
}

['aLimit', 'aPickMin', 'aPickMax', 'aSessMin', 'aSessMax',
  'aStepMin', 'aStepMax', 'aAwayMin', 'aAwayMax', 'aDaily'].forEach((id) => {
  const el = $('#' + id);
  if (!el) return;
  el.addEventListener('input', updateCalc);
  el.addEventListener('change', updateCalc);
});
updateCalc();   // 首屏先按 HTML 里的默认值算一次

/* 高级折叠。默认收起 —— 那六个节奏参数都有校准过的默认值，
 * 摆在外面会让人以为「每个都得填」。收起不影响取值：input 还在 DOM 里。 */
$('#advTog').addEventListener('click', () => {
  const box = $('#advBox');
  const open = box.classList.toggle('open');
  $('#advTog').classList.toggle('on', open);
  $('#advTog').setAttribute('aria-expanded', open ? 'true' : 'false');
});

/* ── 三块卡各自折叠 ──
 * 自动循环 / 本轮帖子 / 日志 原来是挤在一张卡里的，只能整页往下滚。
 * 现在各自能收，收哪块记在 localStorage 里，下次打开还是那个样子。
 * 「开始」按钮在标题行里，点它不能顺手把卡也收起来。 */
const TOG_KEY = 'xr:tog';
const TOG_CARDS = Array.from(document.querySelectorAll('.card.tog'));

function togRead() {
  try { return JSON.parse(localStorage.getItem(TOG_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function togWrite() {
  const o = {};
  TOG_CARDS.forEach((c) => { o[c.dataset.key] = c.classList.contains('open'); });
  try { localStorage.setItem(TOG_KEY, JSON.stringify(o)); } catch (e) { /* 写不进去就算了，不影响用 */ }
}

/* 先按上次存的状态摆好（HTML 里默认是展开的） */
const togSaved = togRead();
TOG_CARDS.forEach((c) => {
  const k = c.dataset.key;
  if (k && k in togSaved) c.classList.toggle('open', !!togSaved[k]);
});

TOG_CARDS.forEach((c) => {
  const head = c.querySelector('[data-tog]');
  if (!head) return;
  const syncAria = () => head.setAttribute('aria-expanded', c.classList.contains('open') ? 'true' : 'false');
  syncAria();
  head.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;   // 点「开始 / 停止」不算收卡
    c.classList.toggle('open');
    syncAria();
    togWrite();
  });
});

/* 「每天最多发几条」和顶部那格「今日 0 / 60」是同一个数（cfg.dailyMax）。
 * 以前这个字段要等点「开始」才存，于是出现两种难受的情况：
 *   1. 填了 30，顶部还写着 / 60，看着像没生效；
 *   2. 填了 30 直接关面板 —— 这个 30 根本没存下去。
 * 所以它单独联动：改完就存，顶部立刻跟着变。
 * 用 change 不用 input：数字框每敲一个键都会 input，敲 30 会先存成 3。
 * 其余参数不动 —— 它们要跟着「开始」一起提交，半改的字段不能被顺手存掉。 */
$('#aDaily').addEventListener('change', async () => {
  const el = $('#aDaily');
  const v = Math.min(500, Math.max(1, Math.round(+el.value || 60)));
  el.value = v;
  updateCalc();               // 上面的监听按旧值算过一次，这里补一遍

  try {
    await call('xr:saveCfg', { patch: { dailyMax: v } });
    if (lastCfg) lastCfg.dailyMax = v;
    /* 只改这一格，不整个 refresh：refresh 会顺手把别的框按后台配置刷一遍 */
    $('#stSent').textContent = lastSentToday + ' / ' + v;
    if (lastSentToday >= v) {
      toast('今日已经发了 ' + lastSentToday + ' 条，上限填 ' + v + ' 的话开起来会立刻停');
    }
  } catch (e) {
    toast('上限没存上：' + e.message);
    if (lastCfg && lastCfg.dailyMax) el.value = lastCfg.dailyMax;
    updateCalc();
  }
});

/* ── 状态刷新 ── */
/* 每 1.5 秒一次，但后台偶尔会慢（worker 刚醒、x.com 标签卡住）。
 * 上一次还没回来就跳过这一次，不然请求会越堆越多。 */
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try { await refreshOnce(); } finally { refreshing = false; }
}

async function refreshOnce() {
  let s;
  try { s = await call('xr:get'); } catch (e) {
    /* 后台没回话（worker 正在睡 / 刚被回收）—— 别在这里干等着，
     * 直接从 storage 读一次状态，否则按钮会永远停在「停止中…」 */
    $('#stPage').textContent = '后台没响应';
    $('#dotPage').className = 'dot off';
    const raw = await readLpRaw();
    syncLoopState(!!(raw && raw.running));
    return;
  }
  lastCfg = s.cfg;

  $('#dotPage').className = 'dot ' + (s.pageOk ? 'on' : 'warn');
  $('#stPage').textContent = s.pageOk ? ('已连 ' + (s.extVer || s.ver)) : '未打开';

  $('#dotMd').className = 'dot ' + (s.hasModel ? 'on' : 'warn');
  $('#stMd').textContent = s.hasModel ? (s.cfg.model || '已配置') : '未配置';

  lastSentToday = +s.sentToday || 0;
  $('#stSent').textContent = s.sentToday + ' / ' + s.dailyMax;

  /* 关注底账。今天关注了几个、有没有满 7 天该回看一眼的。
   * 只记不删 —— 取关是作者自己动手的事。 */
  const fol = Array.isArray(s.followLog) ? s.followLog : [];
  const folToday = +s.followToday || 0;
  const folDue = fol.filter((x) => x.due).length;

  /* 转推 / 引用底账。一天一两个，所以这里只看「今天几个 + 最近几条」。 */
  const rep = Array.isArray(s.repostLog) ? s.repostLog : [];
  const repToday = +s.repostToday || 0;
  const qte = Array.isArray(s.quoteLog) ? s.quoteLog : [];
  const qteToday = +s.quoteToday || 0;
  /* 每天抽到的配额（-1 = 今天还没抽）。面板上要把「抽到几个」写出来，
   * 不然「今天转了 1 个」看着像漏了 —— 其实今天只抽到 1。 */
  const repTarget = s.repostTarget == null ? -1 : +s.repostTarget;
  const qteTarget = s.quoteTarget == null ? -1 : +s.quoteTarget;

  const L = s.loop || {};
  const V = s.vis || {};
  syncLoopState(!!L.running);

  const bits = [];
  /* brief 是卡片收起来时标题行右边那句：只留最关键的一两项。
   * 完整状态还是 #abStat，展开才看得到 —— 所以收起来不等于瞎了。 */
  let brief = '';
  if (L.running) {
    bits.push('<span class="k">第 ' + L.round + ' 轮</span>');
    if (L.batch && L.batch.length) bits.push('本轮 ' + L.batch.length + ' 条');
    bits.push('已回 <b style="color:#E8EDF4">' + L.sent + '</b>');
    if (L.fail) bits.push('失败 <b style="color:#E39A95">' + L.fail + '</b>');
    if (L.waitLeft > 0) {
      /* away 是"走开了"，window 是"等下一个时间段"，fetch 是"这批空了/回完了，
       * 等下一批"，wait 才是"这一段里等下一跳"，reading 是"在读这条、想怎么说"。
       * 全显示成"休息中"的话，作者分不清是自己设的、时间没到、还是卡住了 */
      const label = L.reading ? '在看这条'
        : (L.phase === 'away' ? '走开了'
          : (L.phase === 'window' ? '等下一个时间段'
            : (L.phase === 'fetch' ? '等下一批' : '等下一条')));
      bits.push('<span class="wait">' + label + ' ' + fmtLeft(L.waitLeft) + '</span>');
      brief = label + ' ' + fmtLeft(L.waitLeft);
    } else if (!L.round) {
      // 停止后立刻重开时，旧的那条还在页面里发，得等它收尾才轮到这里
      bits.push('<span class="wait">等上一条收尾…</span>');
      brief = '等上一条收尾…';
    } else {
      brief = '第 ' + L.round + ' 轮';
    }
    brief += ' · 已回 ' + L.sent + (folToday ? ' · 关注 ' + folToday : '') +
      (repToday ? ' · 转推 ' + repToday : '') + (qteToday ? ' · 引用 ' + qteToday : '');

    /* 页面在不在前台。这条不说清楚的话，作者只会看到「一直没反应」，
     * 猜不出是窗口被切走了还是真卡住了。
     *
     * 页面不可见时浏览器会停掉渲染，X 的虚拟列表不再出新的 ——
     * 光靠把等待搬到后台是绕不过这个的，只能提醒人切回去。
     *
     * stale 只跟 pageOk 一起看：标签页真被关了，顶部已经写「未打开」，
     * 这里再报一句「没响应」就是重复。标签页还在但不报心跳，才是卡死。 */
    if (V.stale && s.pageOk) {
      bits.push('<span class="bg bad">页面没响应</span>');
      brief += ' · 页面没响应';
    } else if (V.state === 'hidden') {
      bits.push('<span class="bg">页面在后台</span>');
      brief += ' · 后台';
    }
  } else if (L.round) {
    bits.push('上次回了 ' + L.sent + ' 条' + (L.fail ? '，失败 ' + L.fail : ''));
    /* 展开时下面那句已经写了「上次回了 N 条」，标题行别照抄一遍 */
    brief = '已停 · 回了 ' + L.sent + ' 条';
  }
  $('#abStat').innerHTML = bits.join('<span style="color:#5F6B7A"> · </span>');
  $('#autoSub').textContent = brief || '抓一批 → 挑几条回 → 回够了走开一会';
  /* 页面在后台的时候，标题行那句变金色。
   * 卡片收起来之后这是唯一看得见的地方，灰色的一小串「后台」没人会注意到。 */
  $('#autoBox').classList.toggle('bg', !!(L.running && V.state === 'hidden'));

  if (L.log && L.log.length) {
    const tail = L.log[L.log.length - 1];
    /* 收起时标题行显示最后一行。开头的时间戳要去掉 —— 窄屏下那串
     * 「20:31:09  」就把整句挤没了，等于什么都没说。 */
    $('#logSub').textContent = tail.replace(/^\d{2}:\d{2}:\d{2}\s+/, '');
    if (tail !== lastLogTail) {
      lastLogTail = tail;
      const box = $('#abLog');
      const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
      box.textContent = L.log.join('\n');
      // 下一帧再滚：刚换完内容时高度还没算准，直接滚会差半行
      if (atBottom) requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
    }
  }

  const batch = L.batch || [];
  /* 帖子卡：没内容时整张不出现（省地方），有内容时标题行给个统计。
   * 统计口径跟下面卡片的样式判断保持一致，别两处各算一套。 */
  $('#batchBox').style.display = batch.length ? '' : 'none';
  if (batch.length) {
    let nOk = 0, nBad = 0, nSkip = 0;
    batch.forEach((b) => {
      const st = b.state || '';
      if (/失败|超长|空回复|生成失败|不确定/.test(st)) nBad++;
      else if (/已发|已填/.test(st)) nOk++;
      else if (st === '跳过') nSkip++;
    });
    const nWait = batch.length - nOk - nBad - nSkip;
    $('#batchSub').textContent = '已回 ' + nOk +
      (nBad ? ' · 失败 ' + nBad : '') +
      (nSkip ? ' · 跳过 ' + nSkip : '') +
      (nWait ? ' · 待发 ' + nWait : '');
  }

  const sig = JSON.stringify(batch);
  if (sig !== lastBatchSig) {
    lastBatchSig = sig;
    $('#abBatch').innerHTML = batch.map((b) => {
      const bad = /失败|超长|空回复|生成失败|不确定|没写出人话/.test(b.state || '');
      const ok = /已发|已填|只关注|已转推|只转推|已引用|引用中|已填引用/.test(b.state || '');
      const skip = b.state === '跳过';
      /* 关注、转推、引用都是这条自己的属性，跟回不回复无关 —— 所以各自挂个标，
       * 一眼能看出「这条没回，但这个人跟了 / 这条内容转出去了 / 引了一条」。
       * 标上不带数字：模型给的是分数（3~5 分），跟旁边「今天 引 1/2」那种
       * 数量挨着看会读混 —— 「引 3」不是「引了 3 条」。 */
      const fmark = b.follow > 0
        ? '<span class="bs ok" title="模型觉得这个作者值得跟，处理到这条时会关注">可跟</span>'
        : '';
      const rmark = b.repost > 0
        ? '<span class="bs ok" title="模型觉得这条内容值得转到自己时间线上">可转</span>'
        : '';
      const qmark = b.quote > 0
        ? '<span class="bs ok" title="模型觉得这条值得加一句话引出去">可引</span>'
        : '';
      return '<div class="bi">' +
        '<div class="bh"><b>' + esc(b.author || '') + '</b>' + fmark + rmark + qmark +
        '<span class="bs ' + (ok ? 'ok' : (bad ? 'bad' : '')) + '"' +
        (skip ? ' title="这一轮没挑中它，不回复"' : '') + '>' + esc(b.state || '') + '</span></div>' +
        '<div class="bt">' + esc(b.text || '') + '</div>' +
        (b.why ? '<div class="bw">' + (skip ? '没回：' : '挑它：') + esc(b.why) + '</div>' : '') +
        (b.reply ? '<div class="br">' + esc(b.reply) + '</div>' : '') +
        /* 引用发出去的是真帖，所以正文也要显示出来 —— 作者得能一眼看见
         * 「程序替我发了这句话」。被打回的稿也留着，好让人知道它写歪在哪。 */
        (b.quoteText ? '<div class="br">引：' + esc(b.quoteText) + '</div>' : '') +
        (b.quoteBad ? '<div class="bw">打回的稿：' + esc(String(b.quoteBad).slice(0, 50)) + '</div>' : '') +
        (b.acts && b.acts.length ? '<div class="ba">顺手：' + esc(b.acts.join('、')) + '</div>' : '') +
        '</div>';
    }).join('');
  }

  /* ── 关注底账 ──
   * 有关注记录才把这张卡放出来。满 7 天的标红，提醒回看一眼要不要留着；
   * 程序自己绝不取关，那是作者的决定。 */
  if (fol.length || folToday) {
    $('#folBox').style.display = '';
    $('#folSub').textContent = '今天 ' + folToday + ' 个' +
      (folDue ? ' · 待回看 ' + folDue : '') + ' · 共 ' + fol.length;

    const fsig = JSON.stringify(fol);
    if (fsig !== lastFolSig) {
      lastFolSig = fsig;
      $('#folList').innerHTML = fol.slice().reverse().map((x) => {
        const when = x.days === 0 ? '今天' : (x.days + ' 天前');
        return '<div class="bi">' +
          '<div class="bh"><b>@' + esc(x.h) + '</b>' +
          '<span class="bs ' + (x.due ? 'bad' : '') + '">' +
          (x.due ? '满 ' + x.days + ' 天，回看一眼' : when) + '</span></div>' +
          (x.why ? '<div class="bw">' + esc(x.why) + '</div>' : '') +
          '</div>';
      }).join('');
    }
  }

  /* ── 转发底账（转推 + 引用）──
   * 一天一两个，所以这张表通常很短。放出来是为了让作者能回头核对：
   * 「今天真动了几个」「这句话是程序替我发的吗」。
   * 引用那条带正文 —— 它是永久帖，必须能看见原文。 */
  const fwd = rep.map((x) => Object.assign({}, x, { t: '转' }))
    .concat(qte.map((x) => Object.assign({}, x, { t: '引' })))
    .sort((a, b) => (+a.at || 0) - (+b.at || 0));

  if (fwd.length || repToday || qteToday) {
    $('#repBox').style.display = '';
    /* 配额是每天现抽的，所以写「已用 / 抽到」而不是「已用 / 上限」——
     * 不然今天只抽到 1 个、转了 1 个，看着像漏了。 */
    $('#repSub').textContent =
      '今天 转 ' + repToday + '/' + (repTarget < 0 ? '?' : repTarget) +
      ' · 引 ' + qteToday + '/' + (qteTarget < 0 ? '?' : qteTarget) +
      ' · 共 ' + fwd.length;

    const rsig = JSON.stringify(fwd);
    if (rsig !== lastRepSig) {
      lastRepSig = rsig;
      $('#repList').innerHTML = fwd.slice().reverse().map((x) => {
        const when = x.days === 0 ? '今天' : (x.days + ' 天前');
        return '<div class="bi">' +
          '<div class="bh"><b>' + esc(x.t) + (x.h ? ' @' + esc(x.h) : '') + '</b>' +
          '<span class="bs">' + when + '</span></div>' +
          (x.text ? '<div class="br">' + esc(x.text) + '</div>' : '') +
          (x.why ? '<div class="bw">' + esc(x.why) + '</div>' : '') +
          '</div>';
      }).join('');
    }
  }

  if (!settingsOpen && !paramsDirty) fillPanelFromCfg(s.cfg);
}

function fmtLeft(sec) {
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  return m + '分' + (r ? r + 's' : '');
}

/* 面板上的参数只在没跑的时候跟后台同步，免得打字打到一半被覆盖 */
function fillPanelFromCfg(c) {
  if (!c) return;
  if (c.tabLabel) $('#aTab').value = c.tabLabel;
  if (c.limit) $('#aLimit').value = Math.min(30, c.limit) || 10;
  if (c.pickMin) $('#aPickMin').value = c.pickMin;
  if (c.pickMax) $('#aPickMax').value = c.pickMax;
  if (c.sessMin) $('#aSessMin').value = c.sessMin;
  if (c.sessMax) $('#aSessMax').value = c.sessMax;
  if (c.stepMin) $('#aStepMin').value = c.stepMin;
  if (c.stepMax) $('#aStepMax').value = c.stepMax;
  if (c.awayMin) $('#aAwayMin').value = c.awayMin;
  if (c.awayMax) $('#aAwayMax').value = c.awayMax;
  if (c.dailyMax) $('#aDaily').value = c.dailyMax;
  $('#aHuman').checked = c.human !== false;
  $('#aScreen').checked = c.screen !== false;
  $('#aWin').value = c.windows || '';
  $('#aFollow').checked = c.autoFollow !== false;
  if (c.followDaily != null) $('#aFollowDaily').value = c.followDaily;
  if (c.followMinScore) $('#aFollowMinScore').value = c.followMinScore;
  if (c.followMaxReplies) $('#aFollowMaxReplies').value = c.followMaxReplies;
  if (c.followMaxLikes) $('#aFollowMaxLikes').value = c.followMaxLikes;
  $('#aRepost').checked = c.autoRepost !== false;
  if (c.repostDaily != null) $('#aRepostDaily').value = c.repostDaily;
  $('#aQuote').checked = c.autoQuote !== false;
  if (c.quoteDaily != null) $('#aQuoteDaily').value = c.quoteDaily;
  if (c.quoteMaxReplies) $('#aQuoteMaxReplies').value = c.quoteMaxReplies;
  syncPickRange();
  updateCalc();
}

/* 「最多回几条（每批）」这两个框：
 *   - 上限不能超过「每次往下看几条」，超了就压回去
 *   - 跑起来的时候跟其他参数一样锁住 */
function syncPickRange() {
  const limit = Math.min(30, Math.max(1, Math.round(+$('#aLimit').value || 10)));
  const lo = $('#aPickMin');
  const hi = $('#aPickMax');
  lo.max = limit;
  hi.max = limit;
  if (+hi.value > limit) hi.value = limit;
  if (+lo.value > limit) lo.value = limit;
  if (+lo.value > +hi.value) hi.value = lo.value;
  lo.disabled = loopState !== 'idle';
  hi.disabled = loopState !== 'idle';
}

/* 成对的「最小 ~ 最大」框：填反了（比如 100 / 50）自动纠正。
 * 不纠正的话界面显示的是 100~50，实际跑的是 100~100，看着和实际对不上。
 * 上下限的封顶值跟 background 的 sanitizeCfg 对齐 —— 面板放得进 800，
 * 后台压到 600 的话，界面说的和跑的就不是一回事了。 */
function fixPair(loId, hiId, min, maxLo, maxHi) {
  const lo = $('#' + loId);
  const hi = $('#' + hiId);
  if (!lo || !hi) return;
  const a = Math.min(maxLo, Math.max(min, Math.round(+lo.value || min)));
  const b = Math.min(maxHi, Math.max(a, Math.round(+hi.value || a)));
  lo.value = a;
  hi.value = b;
}

/* ── 自动循环 ── */
/* 按钮有三个状态，别再用 dataset 记了（上次就是它导致卡在「停止中…」）：
 *   idle     可以开始
 *   running  正在跑，按钮是「停止」
 *   stopping 已经点了停止，等后台确认；这期间点它不做任何事 */
let loopState = 'idle';

function renderAutoBtn() {
  const b = $('#btnAuto');
  const busyLoop = loopState !== 'idle';
  b.textContent = loopState === 'running' ? '停止' : (loopState === 'stopping' ? '停止中…' : '开始');
  b.className = 'btn ' + (loopState === 'idle' ? 'primary' : 'danger');
  b.disabled = loopState === 'stopping';
  /* 只切 run，别整个覆盖 className —— 那会把 tog / open 一起抹掉，
   * 卡片就再也折不起来了（第一次跑就是栽在这）。 */
  $('#autoBox').classList.toggle('run', busyLoop);
  PARAM_IDS.forEach((id) => { const el = $('#' + id); if (el) el.disabled = busyLoop; });
  syncPickRange();   // 必须在上面之后：它会按「每轮怎么回」再把挑几条锁一遍
  const lock = $('#aLock');
  if (lock) lock.className = 'lockhint' + (busyLoop ? ' on' : '');
}

/* 以后台的真实状态为准：确认停了才把按钮放回「开始」 */
function syncLoopState(running) {
  if (running) {
    if (loopState !== 'running') { loopState = 'running'; renderAutoBtn(); }
    return;
  }
  if (loopState !== 'idle') { loopState = 'idle'; renderAutoBtn(); }
}

/* 时间段跟后台同一个解析规则（background.js 的 parseWindows）。
 * 放在这里是为了在点开始之前就能告诉作者「这段我没看懂」——
 * 不然格式写错了后台会当成全天跑，作者还以为限制了时间。 */
function parseWindowsLite(str) {
  const out = [];
  String(str || '').split(/[,，;；\s]+/).forEach((seg) => {
    const m = seg.match(/^(\d{1,2}):(\d{2})\s*[-~到]\s*(\d{1,2}):(\d{2})$/);
    if (!m) return;
    const h1 = +m[1], m1 = +m[2], h2 = +m[3], m2 = +m[4];
    if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return;
    const a = h1 * 60 + m1;
    const b = h2 * 60 + m2;
    if (a === b) return;
    out.push({ a, b });
  });
  return out;
}

const fmtHM = (m) =>
  String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

function panelParams() {
  const limit = Math.min(30, Math.max(1, Math.round(+$('#aLimit').value || 10)));
  const sessMin = Math.min(30, Math.max(1, Math.round(+$('#aSessMin').value || 4)));
  const sessMax = Math.min(30, Math.max(sessMin, Math.round(+$('#aSessMax').value || 8)));
  const stepMin = Math.min(600, Math.max(20, Math.round(+$('#aStepMin').value || 30)));
  const stepMax = Math.min(900, Math.max(stepMin, Math.round(+$('#aStepMax').value || 70)));
  const awayMin = Math.min(240, Math.max(3, Math.round(+$('#aAwayMin').value || 15)));
  const awayMax = Math.min(360, Math.max(awayMin, Math.round(+$('#aAwayMax').value || 45)));
  const daily = Math.min(500, Math.max(1, Math.round(+$('#aDaily').value || 60)));
  /* 挑几条：不能超过每轮抓的条数，也不能反过来（上限小于下限） */
  const pickMax = Math.min(limit, Math.max(1, Math.round(+$('#aPickMax').value || 3)));
  const pickMin = Math.min(pickMax, Math.max(1, Math.round(+$('#aPickMin').value || 1)));
  return {
    sessMin, sessMax, stepMin, stepMax, awayMin, awayMax, daily,
    tabLabel: $('#aTab').value.trim() || '加密',
    human: $('#aHuman').checked,
    limit,
    pickMin, pickMax,
    screen: $('#aScreen').checked,
    windows: $('#aWin').value.trim(),
    autoFollow: $('#aFollow').checked,
    /* 0 是合法值（今天不关注），不能用 || 兜底把它变成 40 */
    followDaily: Math.min(100, Math.max(0, Math.round(
      $('#aFollowDaily').value === '' ? 40 : +$('#aFollowDaily').value))),
    followMinScore: Math.min(3, Math.max(1, Math.round(+$('#aFollowMinScore').value || 2))),
    followMaxReplies: Math.min(5000, Math.max(10, Math.round(+$('#aFollowMaxReplies').value || 150))),
    followMaxLikes: Math.min(100000, Math.max(50, Math.round(+$('#aFollowMaxLikes').value || 3000))),
    autoRepost: $('#aRepost').checked,
    /* 同样是配额上限，允许 0（今天不转） */
    repostDaily: Math.min(10, Math.max(0, Math.round(
      $('#aRepostDaily').value === '' ? 2 : +$('#aRepostDaily').value))),
    autoQuote: $('#aQuote').checked,
    quoteDaily: Math.min(10, Math.max(0, Math.round(
      $('#aQuoteDaily').value === '' ? 3 : +$('#aQuoteDaily').value))),
    quoteMaxReplies: Math.min(5000, Math.max(10, Math.round(+$('#aQuoteMaxReplies').value || 150))),
  };
}

$('#btnAuto').onclick = async () => {
  if (loopState === 'stopping') return;   // 正在停，别重复点

  if (loopState === 'running') {
    loopState = 'stopping';
    renderAutoBtn();
    try {
      await call('xr:loopStop', null, 8000);
    } catch (e) {
      /* 没回话不代表没停成，别急着把按钮弹回去 —— 下面 refresh 会看真实状态 */
      toast('停止：' + e.message);
    }
    await refresh();                        // 由后台的真实状态决定按钮长什么样
    if (loopState === 'stopping') {         // 连 refresh 都没拿到状态，自己兜底
      const raw = await readLpRaw();
      loopState = raw && raw.running ? 'running' : 'idle';
      renderAutoBtn();
    }
    return;
  }

  const p = panelParams();

  /* 时间段填了但一句都没解析出来 —— 后台会当成全天跑。
   * 与其让它默默跑 24 小时，不如现在就说清楚。 */
  const wins = parseWindowsLite(p.windows);
  if (p.windows && !wins.length) {
    alert('「只在几个时间段跑」这行没看懂：' + p.windows +
      '\n\n照这个格式写：09:00-11:00, 20:00-23:00' +
      '\n想全天都能跑，就把这行清空。');
    return;
  }

  if (lastCfg && lastCfg.base) {
    const okPerm = await ensureHost(lastCfg.base);
    if (!okPerm) toast('没给 ' + lastCfg.base + ' 的访问权限，模型可能调不通');
  }

  try {
    await call('xr:saveCfg', {
      patch: {
        tabLabel: p.tabLabel,
        sessMin: p.sessMin, sessMax: p.sessMax,
        stepMin: p.stepMin, stepMax: p.stepMax,
        awayMin: p.awayMin, awayMax: p.awayMax,
        dailyMax: p.daily,
        human: p.human, limit: p.limit,
        pickMin: p.pickMin, pickMax: p.pickMax,
        screen: p.screen, windows: p.windows,
      },
    });
    paramsDirty = false;      // 存过了，之后可以跟后台配置同步
  } catch (e) { toast('参数没存上：' + e.message); return; }

  const how = '每次往下看 ' + p.limit + ' 条，挑 ' + p.pickMin + '~' + p.pickMax + ' 条回' +
    (p.screen ? '（先让模型挑，挑不出就空着翻下一批）' : '（随机挑）') + '，其余跳过';

  /* 确认框是最后一道"你知道接下来会发生什么吗"。
   * 会话制最容易被误会成卡住 —— 中间那几十分钟是真的什么都不干，
   * 所以必须写清楚"走开"这件事，而不是只说一个间隔数字。 */
  const secStr = (s) => (s < 90 ? Math.round(s) + ' 秒' : (Math.round(s / 6) / 10) + ' 分钟');

  const paceHow =
    '· 一次坐下回 ' + p.sessMin + '~' + p.sessMax + ' 条，两条之间隔 ' +
      secStr(p.stepMin) + '~' + secStr(p.stepMax) + '\n' +
    '· 回够了就走开 ' + p.awayMin + '~' + p.awayMax + ' 分钟，回来接着刷\n' +
    '· 连着翻 3 批都没一条想回的，也提前走开\n';

  if (!confirm(
    '会真的把回复发出去：\n' +
    '· ' + how + '\n' +
    paceHow +
    (wins.length ? ('· 只在 ' + wins.map((w) => fmtHM(w.a) + '-' + fmtHM(w.b)).join('、') +
      ' 里跑，其余时间自动停\n') : '') +
    '\n走开的时候程序在等，不是卡住了。\n' +
    '一直循环到你点停止。\n\n确定？'
  )) return;

  const b = $('#btnAuto');
  b.disabled = true;
  try {
    await call('xr:loopStart', { limit: p.limit, dryRun: false });
    loopState = 'running';
    toast('开始跑了');
  } catch (e) {
    alert(e.message);
  } finally {
    b.disabled = false;
    renderAutoBtn();
    refresh();
  }
};

/* ── 设置 ── */
/* 这里只放"填一次就不动"的东西：接口、Key、模型、人设。
 * 节奏参数全在面板上，这里再放一份的话，两边改起来会打架。 */
$('#btnSet').onclick = async () => {
  try {
    const s = await call('xr:get');
    const c = s.cfg;
    $('#cBase').value = c.base || '';
    $('#cKey').value = '';
    $('#cKey').placeholder = c.key ? '已存 Key（' + c.key + '），不改就留空' : 'sk-...';
    $('#cModel').value = c.model || 'deepseek-chat';
    $('#cPersona').value = c.persona || '';
    $('#testOut').style.display = 'none';
    settingsOpen = true;
    $('#mSet').classList.add('on');
  } catch (e) { alert('读配置失败：' + e.message); }
};

$('#setClose').onclick = () => { settingsOpen = false; $('#mSet').classList.remove('on'); };

$('#setSave').onclick = async () => {
  /* 只提交设置弹层里独有的字段。
   * 节奏参数 / tab 都归上面参数区管 —— 这里再存一遍的话，
   * 会把作者在参数区改了一半、还没点开始的东西悄悄盖回去。 */
  const patch = {
    base: $('#cBase').value.trim(),
    model: $('#cModel').value.trim() || 'deepseek-chat',
    persona: $('#cPersona').value.trim(),
  };
  const k = $('#cKey').value.trim();
  if (k && !/^•+$/.test(k)) patch.key = k;

  if (patch.base) {
    const okPerm = await ensureHost(patch.base);
    if (!okPerm) toast('没给这个域名的权限，模型会调不通');
  }

  try {
    await call('xr:saveCfg', { patch });
    settingsOpen = false;
    $('#mSet').classList.remove('on');
    paramsDirty = false;      // 设置里改的（比如间隔）要让上面那几个框跟着变
    toast('存好了');
    refresh();
  } catch (e) { alert('保存失败：' + e.message); }
};

$('#setTest').onclick = async () => {
  const out = $('#testOut');
  out.style.display = 'block';
  out.textContent = '正在调模型…';
  const b = $('#setTest');
  b.disabled = true;
  try {
    /* 先存一次，不然测的是旧配置 */
    const patch = { base: $('#cBase').value.trim(), model: $('#cModel').value.trim() || 'deepseek-chat' };
    const k = $('#cKey').value.trim();
    if (k && !/^•+$/.test(k)) patch.key = k;
    if (patch.base) await ensureHost(patch.base);
    await call('xr:saveCfg', { patch });

    const r = await call('xr:testModel', null, 60000);   // 模型有时候慢，给足 60 秒
    out.textContent = '通了（' + (r.ms / 1000).toFixed(1) + ' 秒）· 样例：' + (r.sample || '（空）');
  } catch (e) {
    out.textContent = '失败：' + e.message;
  } finally {
    b.disabled = false;
  }
};

$('#setReset').onclick = async () => {
  if (!confirm('清空「抓过 / 回过」的记录？\n\n清完循环会把之前回过的帖子当成新的，可能重复回复。只在测试时用。')) return;
  try {
    await call('xr:reset');
    lastBatchSig = '';
    lastLogTail = '';
    toast('清空了');
  } catch (e) { alert('清空失败：' + e.message); }
};

$('#btnFull').onclick = () => { call('xr:openTab').catch(() => {}); };

$$('.mask').forEach((m) => {
  m.addEventListener('click', (e) => {
    if (e.target === m) { m.classList.remove('on'); settingsOpen = false; }
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $$('.mask.on').forEach((m) => m.classList.remove('on')); settingsOpen = false; }
});

/* 面板开着就每 1.5 秒问一次状态（顺便替引擎当心跳） */
setInterval(refresh, 1500);
refresh();
