/* 回帖助手 · content script
 * 跑在 x.com 页面里，负责真正读页面、点按钮、填文字。
 */
(() => {
  if (window.__xreplyLoaded) return;
  window.__xreplyLoaded = true;

  const VER = 'v25';   // 版本号：日志和面板里都会带，用来确认新脚本到底加载了没

  /* 等待不能靠页面自己的 setTimeout。
   *
   * 页面切到后台（换 tab、最小化、被别的窗口整个盖住）之后，Chrome 会把
   * 定时器压到 1 秒一次；隐藏超过 5 分钟还会进入 intensive throttling，
   * 直接压到 60 秒一次。一条回复里有十几次 sleep，全被拉长就是十几分钟，
   * 外面看着就是卡死了。
   *
   * 改成让后台计时、到点回一条消息。后台是 service worker，没有可见性这个概念，
   * setTimeout 不受上面那套节流影响；页面这边只是被动收消息，也不用定时器。
   * 挂着的 sendResponse 本身会让 worker 保持存活，所以几秒级的等待不会丢。
   *
   * 兜底：后台万一被浏览器回收、消息回不来，本地定时器还是会把 Promise 结束掉。
   * 最坏多等 ms+15 秒，但不会永远悬着 —— 悬着就意味着这条回复永远发不出去。
   */
  const sleep = (ms) => new Promise((r) => {
    let done = false;
    const fin = () => { if (!done) { done = true; r(); } };
    try {
      chrome.runtime.sendMessage({ type: 'nap', ms }, () => {
        void chrome.runtime.lastError;   // 后台没醒过来也不算错，下面兜底会接
        fin();
      });
    } catch (e) { fin(); }             // 扩展被重载，上下文没了
    setTimeout(fin, ms + 15000);
  });
  const RESUME_KEY = 'xr_resume';

  const norm = (s) => (s || '').replace(/\s+/g, '');

  /* X 把大数写成 1.2K / 3.4万 / 5M，直接 parseInt 会得到 1。
   * 关注筛选要靠这个数判断「这条帖子还抢不抢得到前排」，所以必须解析准。 */
  function parseNum(s) {
    if (s == null) return 0;
    const m = String(s).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([KkMm万億亿]?)/);
    if (!m) return 0;
    let n = parseFloat(m[1]);
    if (!isFinite(n)) return 0;
    const u = m[2];
    if (u === 'K' || u === 'k') n *= 1e3;
    else if (u === 'M' || u === 'm') n *= 1e6;
    else if (u === '万') n *= 1e4;
    else if (u === '亿' || u === '億') n *= 1e8;
    return Math.round(n);
  }

  /* ── 顶部的 tab（为你推荐 / 正在关注 / 加密 …） ── */
  function allTabs() {
    return [...document.querySelectorAll('[role="tab"]')];
  }

  function findTab(label) {
    const want = norm(label);
    if (!want) return null;
    const tabs = allTabs();
    // 先精确匹配，再模糊
    for (const el of tabs) if (norm(el.innerText) === want) return el;
    for (const el of tabs) if (norm(el.innerText).includes(want)) return el;
    return null;
  }

  function activeTab() {
    const tabs = allTabs();
    for (const el of tabs) if (el.getAttribute('aria-selected') === 'true') return el;
    return tabs[0] || null;
  }

  /* 在推文详情页时顶部没有 tab 栏，先点回主页 */
  async function goHome() {
    const home =
      document.querySelector('[data-testid="AppTabBar_Home_Link"]') ||
      document.querySelector('a[href="/home"]');
    if (home) {
      home.click();
      await sleep(2200);
    }
    return allTabs().length > 0;
  }

  async function selectTab(label) {
    if (!label) return { ok: true };

    let el = findTab(label);
    if (!el) {
      // 可能不在主页（比如上一条回复完停在推文详情页），回主页再找一次
      await goHome();
      el = findTab(label);
    }
    if (!el) {
      throw new Error('页面上找不到「' + label + '」这个 tab。先手动点进那个 tab，再回工作台点开始');
    }
    if (el.getAttribute('aria-selected') === 'true') return { ok: true, switched: false };

    el.click();
    await sleep(1200);
    // 等它真的选中
    for (let i = 0; i < 10; i++) {
      const cur = findTab(label);
      if (cur && cur.getAttribute('aria-selected') === 'true') break;
      await sleep(400);
    }
    // 等列表出来
    for (let i = 0; i < 12; i++) {
      if (document.querySelector('article[data-testid="tweet"]')) break;
      await sleep(400);
    }
    return { ok: true, switched: true };
  }

  /* 刷新这个 tab：滚回顶部 + 点一下已选中的 tab（X 会重新拉） */
  async function refreshTimeline(label) {
    /* 分步滚回顶部，不是 scrollTo(0,0) 一下跳上去 ——
     * 页面从底部瞬间闪到顶部，看着就是脚本在操作。 */
    for (let i = 0; i < 16 && window.scrollY > 10; i++) {
      window.scrollBy(0, -(1100 + Math.random() * 900));
      await sleep(90 + Math.random() * 130);
    }
    window.scrollTo(0, 0);
    await sleep(500 + Math.random() * 500);

    const el = (label && findTab(label)) || activeTab();
    if (!el) { location.reload(); return; }

    const before = document.querySelectorAll('article[data-testid="tweet"]').length;
    el.click();
    await sleep(2500);

    // 还不行就轻微滚动催一下
    if (document.querySelectorAll('article[data-testid="tweet"]').length <= before) {
      window.scrollBy(0, 1600);
      await sleep(1200);
      window.scrollTo(0, 0);
      await sleep(900);
    }
  }

  /* ── 读时间线 ── */
  function collect() {
    const out = [];
    document.querySelectorAll('article[data-testid="tweet"]').forEach((el) => {
      if (el.closest('[data-testid="placementTracking"]')) return; // 广告

      const t = el.querySelector('[data-testid="tweetText"]');
      const n = el.querySelector('[data-testid="User-Name"]');
      const a = el.querySelector('a[href*="/status/"]');
      const time = el.querySelector('time');
      if (!t || !a) return;

      const url = a.href.split('?')[0];
      const text = (t.innerText || '').trim();
      if (!text || text.length < 6) return;
      if (/\/photo\/|\/video\//.test(url)) return;

      /* 作者 handle。User-Name 里可能挂着两个链接（显示名 + @handle），
       * 都指向同一个主页；要排除帖子本身的 /status/ 链接。
       *
       * 只认「单个路径段、1~15 位字母数字下划线」—— X 的 screen name 就是这个形状。
       * 以前是把 pathname 里的斜杠全删掉再排除几个固定路径，太松了：
       * /hashtag/btc 会变成 hashtagbtc，/i/lists/123 会变成 ilists123，
       * 这些脏值照样被当成 handle 存进批次。后台去重是按字符串比的，
       * 脏一次就永远对不上同一个人 —— 结果是同一个号被反复关注、反复失败。
       * 宁可留空（留空就不关注），也不要存一个错的。 */
      let handle = '';
      const na = n && n.querySelector('a[href^="/"]:not([href*="/status/"])');
      if (na) {
        const path = new URL(na.href, location.origin).pathname.replace(/\/+$/, '');
        const hm = path.match(/^\/([A-Za-z0-9_]{1,15})$/);
        if (hm && !/^(home|explore|notifications|messages|i|search|settings|compose)$/i.test(hm[1])) {
          handle = hm[1];
        }
      }

      /* 互动数：aria-label 比按钮里那串文字稳（数字有时是 0 就不渲染）。
       * 已点赞时 testid 会变成 unlike，已转推是 unretweet，都要查。 */
      const cnt = (ids) => {
        for (const id of ids) {
          const b = el.querySelector('[data-testid="' + id + '"]');
          if (!b) continue;
          const v = parseNum(b.getAttribute('aria-label')) || parseNum((b.innerText || '').trim());
          if (v) return v;
        }
        return 0;
      };

      out.push({
        url,
        text,
        author: n ? (n.innerText || '').split('\n').filter(Boolean)[0] || '' : '',
        handle,
        iso: time ? time.getAttribute('datetime') : '',
        replies: cnt(['reply']),
        likes: cnt(['like', 'unlike']),
        reposts: cnt(['retweet', 'unretweet']),
        /* 有 socialContext 说明这条是「某人转推了」「某人回复了」带出来的，
         * 不是作者自己发在时间线上的。全自动关注要保守，这种不放进候选。 */
        via: !!el.querySelector('[data-testid="socialContext"]'),
      });
    });
    return out;
  }

  async function fetchTimeline(limit, opts) {
    opts = opts || {};

    if (opts.tab) await selectTab(opts.tab);

    const seenSet = new Set(opts.seen || []);
    const out = new Map();

    const grab = () => {
      for (const item of collect()) {
        if (seenSet.has(item.url) || out.has(item.url)) continue;
        out.set(item.url, item);
        if (out.size >= limit) return;
      }
    };

    /* 往下翻。X 的时间线本来就是往下滑就加载更多，
     * 所以正常路径是「一直翻」，不是「刷一下」。
     *
     * 节奏要像人：以前是 1 秒翻一屏半、连翻 14 次，20 秒干掉 25 屏 ——
     * 人眼扫一条推文都不止 1 秒，这个速度一眼就假。
     * 现在一屏 1.6~3.8 秒，每翻三屏还得多停一下（看到有意思的、或者手停了）。 */
    const scrollFor = async (times) => {
      for (let i = 0; i < times && out.size < limit; i++) {
        window.scrollBy(0, 1200 + Math.random() * 900);
        await sleep(1600 + Math.random() * 2200);
        grab();
        if (i > 0 && i % 3 === 0) await sleep(1500 + Math.random() * 3500);
      }
    };

    grab();
    if (out.size >= limit) return [...out.values()].slice(0, limit);

    await scrollFor(12);
    if (out.size >= limit) return [...out.values()].slice(0, limit);

    /* 翻到底了还不够，才软刷新一次：点一下已选中的 tab，让 X 重新拉。
     * 不 location.reload() —— 整页刷新是这整套动作里最像机器的一步。 */
    if (opts.refresh) {
      await refreshTimeline(opts.tab);
      grab();
      if (out.size >= limit) return [...out.values()].slice(0, limit);
      await scrollFor(6);
    }

    return [...out.values()].slice(0, limit);
  }

  /* ── 找推文对应的 article ── */
  function findArticle(tweetUrl) {
    const m = tweetUrl.match(/status\/(\d+)/);
    if (!m) return null;
    const id = m[1];
    const arts = document.querySelectorAll('article[data-testid="tweet"]');
    for (const el of arts) {
      if (el.querySelector('a[href*="/status/' + id + '"]')) return el;
    }
    return null;
  }

  /* 找到这条推文所在的 article。
   * 时间线是虚拟列表，滚下去之后上面的推文会从 DOM 里被移掉，
   * 所以"抓到了"不等于"点得到"。
   * 顺序：现在就在屏幕上 → 往下翻着找 → 往回翻着找 → 走链接 → 整页跳。
   * 整页跳最省事但最像机器（URL 从一条推文直接跳到另一条），所以放最后。
   */
  async function scrollFind(tweetUrl, step, times) {
    for (let i = 0; i < times; i++) {
      window.scrollBy(0, step);
      await sleep(700 + Math.random() * 500);
      const art = findArticle(tweetUrl);
      if (art) return art;
    }
    return null;
  }

  /* 记一下这条是怎么找到的，回给后台写进日志：
   * screen 本来就在屏幕上 / down·up 翻着找到的 / link 走链接 / jump 整页跳（最差） */
  let locateHow = 'screen';

  async function locate(tweetUrl, noJump) {
    let art = findArticle(tweetUrl);
    if (art) { locateHow = 'screen'; return art; }

    const m = tweetUrl.match(/status\/(\d+)/);
    if (!m) return null;
    const id = m[1];

    // 已经在详情页了，等它渲染出来就行
    if (location.href.split('?')[0] === tweetUrl) {
      locateHow = 'detail';
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        art = findArticle(tweetUrl);
        if (art) return art;
      }
      return null;
    }

    /* 一批帖子是往下翻着抓来的，下一条通常就在下面；
     * 偶尔被顺手滑动滑过头了，就往回翻一点。
     *
     * 搜索深度分两种：
     *   回帖    覆盖「附近几条」就够，找不到还有整页跳兜底
     *   转推/引用 没有兜底（一跳任务就丢），必须一次搜够 ——
     *            一批 10 条帖子在时间线上能铺 8000~12000px，
     *            原来上下各 6400px 根本罩不住，实测就是连着两条转推报「翻不到了」。
     *            往上那趟得先把去程走回来再继续往上，所以次数要比去程多。
     */
    const stepPx = noJump ? 900 : 800;
    const downN = noJump ? 12 : 8;
    const upN = noJump ? downN + 12 : 8;
    const y0 = window.scrollY;

    art = await scrollFind(tweetUrl, stepPx, downN);
    if (art) { locateHow = 'down'; return art; }
    art = await scrollFind(tweetUrl, -stepPx, upN);
    if (art) { locateHow = 'up'; return art; }

    /* 两趟都没找到，把滚动位置还原 —— 否则后面每条都要从
     * 一万多像素以外重新找，越找越偏。只在失败时做，代价可以接受。 */
    if (noJump && Math.abs(window.scrollY - y0) > 200) {
      window.scrollTo(0, y0);
      await sleep(500);
    }

    // 页面上还有这条的链接，就走 X 自己的路由（不刷新，任务能接着跑）
    const link = document.querySelector('a[href*="/status/' + id + '"]');
    if (link) {
      locateHow = 'link';
      link.click();
      for (let i = 0; i < 16; i++) {
        await sleep(500);
        art = findArticle(tweetUrl);
        if (art) return art;
      }
    }

    /* 兜底：整页跳过去。跳完这个脚本就没了，
     * sessionStorage 里的 resume 会在新页面上把这条回复接着做完。
     *
     * noJump 是给转推用的：转推没有「接力」这条路（resume 只认 fetch 和 reply），
     * 整页一跳任务就丢了，还会把循环的滚动位置打乱。
     * 转推本来就一天一两个，翻不到就翻不到，宁可放过。 */
    if (noJump) { locateHow = 'none'; return null; }

    locateHow = 'jump';
    location.href = tweetUrl;
    await sleep(25000); // 正常情况页面早就卸载了，走不到这
    return null;
  }

  /* ── 编辑器定位 ──
   * 两个坑：
   * 1. 时间线顶部有个「有什么新鲜事」的框，和弹窗里的框同名，要优先弹窗、且必须可见。
   * 2. data-testid="tweetTextarea_0" 挂的是**外层容器**，真正能输入的是里面的
   *    div[contenteditable=true]。focus 外层、往里 insertText 是没用的，
   *    而且外层的 innerText 会把 placeholder（"发布你的回复"）也算进去，
   *    看起来像"字填进去了"，其实编辑器是空的 —— 发送按钮自然一直是灰的。
   */
  const BOX_SEL = '[data-testid="tweetTextarea_0"], [data-testid^="tweetTextarea"]';

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }

  function editableOf(box) {
    if (!box) return null;
    if (box.getAttribute && box.getAttribute('contenteditable') === 'true') return box;
    return box.querySelector('[contenteditable="true"]');
  }

  function findComposer() {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')];
    for (let i = dialogs.length - 1; i >= 0; i--) {
      const box = dialogs[i].querySelector(BOX_SEL);
      const ed = editableOf(box);
      if (ed && visible(ed)) return { box, ed, root: dialogs[i] };
    }
    for (const box of document.querySelectorAll(BOX_SEL)) {
      const ed = editableOf(box);
      if (ed && visible(ed)) return { box, ed, root: document };
    }
    return null;
  }

  /* 只在指定范围里找发送按钮。
   * 以前找不到会退回全局 querySelector —— 那会摸到时间线顶部「有什么新鲜事」
   * 那个框的按钮，一点就把回复发成一条独立新推文。宁可不发，也不能发错。 */
  function findSendBtn(root) {
    const sel = '[data-testid="tweetButtonInline"], [data-testid="tweetButton"]';
    if (!root) return null;
    if (root === document) return document.querySelector(sel);
    return root.querySelector ? root.querySelector(sel) : null;
  }

  function btnReady(b) {
    return !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
  }

  function normText(s) {
    return (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /* 把编辑器里的内容全选中。不选中就直接 insertText，字会一直往后堆，
   * 堆过 280 字发送按钮就永久变灰 —— 这就是"累加起来还不发"的原因。
   */
  function selectAllIn(ed) {
    if (!ed) return;
    try { ed.focus(); } catch (e) {}
    try { document.execCommand('selectAll', false, null); } catch (e) {}
    try {
      const r = document.createRange();
      r.selectNodeContents(ed);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    } catch (e) {}
  }

  function clearBox(ed) {
    try {
      selectAllIn(ed);
      document.execCommand('delete', false, null);
    } catch (e) {}
  }

  /* 把可能残留的弹窗（包括"要丢弃草稿吗"那种确认框）关掉 */
  async function closeDialogs() {
    for (let k = 0; k < 3; k++) {
      const d = document.querySelector('[role="dialog"]');
      if (!d) return;

      const discard = [...d.querySelectorAll('div[role="button"], button, [role="button"]')]
        .find((el) => /^(Discard|丢弃|放弃)/.test((el.innerText || '').trim()));
      if (discard) { discard.click(); await sleep(500); continue; }

      const x = d.querySelector('[data-testid="app-bar-close"]') ||
                d.querySelector('[aria-label="Close"]') ||
                d.querySelector('[aria-label="关闭"]');
      if (x) x.click();
      else document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(600);
    }
  }

  /* 三种填字方式，每次先全选覆盖，再用"字数对不对 + 按钮能不能点"验收 */
  async function typeBy(ed, text, how) {
    selectAllIn(ed);
    await sleep(120);

    if (how === 'exec') {
      document.execCommand('insertText', false, text);
    } else if (how === 'paste') {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      ed.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt, bubbles: true, cancelable: true,
      }));
    } else if (how === 'beforeinput') {
      ed.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertText', data: text, bubbles: true, cancelable: true,
      }));
    } else {
      const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/\n/g, '<br>');
      document.execCommand('insertHTML', false, safe);
    }
  }

  /* ── 穿插一点真人动作：滑动、停留、点赞 ──
   * 不做"点开推文再返回"——那会把页面推进 bfcache，消息通道直接断掉，
   * 得不偿失。滑动 + 停留 + 点赞已经足够像人了。
   */
  async function humanize(task) {
    const acts = [];

    /* 点赞放在最前面：滚走之后这条会被虚拟列表回收，findArticle 就找不到了。
     * 以前是先滚再点，结果几乎从来不点。 */
    if (task.like) {
      const art = findArticle(task.url);
      const like = art && art.querySelector('[data-testid="like"]');
      if (like && like.getAttribute('aria-pressed') !== 'true') {
        like.click();
        await sleep(400 + Math.random() * 500);
        acts.push('点赞');
      }
    }

    // 慢慢往下翻一两下，偶尔往回翻 —— 幅度别太大，不然会把下一条甩过去
    const n = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
      const dir = Math.random() < 0.75 ? 1 : -1;
      window.scrollBy(0, dir * (240 + Math.random() * 420));
      await sleep(700 + Math.random() * 1100);
    }
    acts.push('滑动 ' + n + ' 次');

    // 停一会儿，像在看来回扫（发完自己也会瞄一眼发得对不对）
    const dwell = 1500 + Math.random() * 4500;
    await sleep(dwell);
    acts.push('停留 ' + (dwell / 1000).toFixed(1) + ' 秒');

    return { ok: true, acts };
  }

  /* ── 填字并（可选）发出去 ──
   * 回复和引用共用这一段。区别只在「点哪个按钮把编辑器叫出来」——
   * 编辑器一出来，后面的世界完全一样：全选覆盖、四种填法轮着试、
   * 按字数验收、按按钮状态验收、发完还得看有没有弹回「丢弃草稿」。
   * 所以这段必须只有一份：两个动作各写一遍，早晚会有一个先修好一个没修。
   */
  async function fillAndSend(c, text, opt) {
    opt = opt || {};
    const shouldSend = !!opt.send;
    const want = normText(text);
    let ok = false;
    let got = '';
    let diag = '';

    /* ── 打字时间 ──
     * 框已经开了，但字还没落。真人打开输入框之后要想一下才开始打，
     * 不是框一弹出来字就满了。
     * 这部分只在**第一次**填字之前等 —— 后面几次是重试，再等就是白耗时间。
     * 时间由后台按字数算好传过来（55 字/分钟 ×1.3 冗余）。 */
    const typeMs = Math.max(0, Math.round(+opt.typeMs || 0));
    const checkMs = Math.max(0, Math.round(+opt.checkMs || 0));
    if (typeMs) await sleep(Math.round(typeMs * 0.7));

    for (const how of ['exec', 'paste', 'beforeinput', 'html']) {
      try { await typeBy(c.ed, text, how); } catch (e) {}
      await sleep(900);

      c = findComposer() || c;
      got = normText(c.ed.textContent);   // 只看真正可编辑的那层，不含 placeholder
      const btn = findSendBtn(c.root);
      diag = '编辑器 ' + got.length + ' 字 / 应为 ' + want.length +
             '，按钮 ' + (btn ? (btn.getAttribute('data-testid') || '?') +
             (btnReady(btn) ? ' 可点' : ' 灰的') : ' 没找到');

      // 字进了、没堆起来、按钮能点，才算成
      if (got.length > 0 && got.length <= want.length + 10 && btnReady(btn)) { ok = true; break; }

      // 堆起来了就清干净再来一遍
      if (got.length > want.length + 10) { clearBox(c.ed); await sleep(400); }
    }

    if (!ok) {
      if (!got) throw new Error('[' + VER + '] 文字没能填进去（X 的编辑器没接收）｜' + diag);
      if (got.length > want.length + 10) throw new Error('[' + VER + '] 编辑器里的字越堆越多（没清干净）｜' + diag);
      throw new Error('[' + VER + '] 字填进去了但发送按钮还是灰的｜' + diag);
    }

    /* 剩下那一截打字时间 + 发之前扫一眼。真打完字不会立刻点发送，
     * 总会回头看一眼有没有打错。 */
    if (typeMs) await sleep(Math.round(typeMs * 0.3));
    if (checkMs) await sleep(checkMs);

    if (!shouldSend) return { ok: true, sent: false, typed: got };

    findSendBtn(c.root).click();
    await sleep(2800);

    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { ok: true, sent: true, confirmed: true, how: locateHow };

    /* 弹窗还在。如果里面冒出「丢弃草稿 / Discard」，说明 X 根本没发出去 ——
     * 点掉它只是把草稿扔掉。这时候报成功就是骗自己，今日计数也会虚高。 */
    const discard = [...dlg.querySelectorAll('[role="button"], button')]
      .find((el) => /^(Discard|丢弃|放弃)/.test((el.innerText || '').trim()));
    if (discard) {
      discard.click();     // 收掉草稿，别留着串到下一条
      await sleep(500);
      throw new Error('没发出去（X 弹了「丢弃草稿」）');
    }

    /* 发完把框收掉，回到时间线上 —— 停在弹窗里等两分钟太怪了，
     * 而且下一条还得先关框。 */
    await closeDialogs();
    return { ok: true, sent: true, confirmed: false, how: locateHow };
  }

  /* ── 回复一条 ── */
  async function doReply(task) {
    const tweetUrl = task.url;

    await closeDialogs();

    const art = await locate(tweetUrl);
    if (!art) throw new Error('这条推文打不开（可能被删了或者需要重新加载页面）');

    /* 找到之后先停一下再点回复。真人总得先看一眼再回，
     * 找到了立刻点按钮反而假。顺便重新找一次 article —— 虚拟列表
     * 可能在这几百毫秒里把它回收掉了。 */
    await sleep(600 + Math.random() * 1400);
    const art2 = findArticle(tweetUrl) || art;

    const replyBtn = art2.querySelector('[data-testid="reply"]');
    if (!replyBtn) throw new Error('这条没有回复按钮（可能是广告或纯转推）');
    replyBtn.click();

    // 等编辑器真的出来（弹窗有动画，别急着找）
    // 注意：时间线顶部那个「有什么新鲜事」也会被 findComposer 找到，
    // 用它填字会发成一条新推文而不是回复，所以必须确认是弹窗里的（或详情页的内联回复框）
    let c = null;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const cand = findComposer();
      if (!cand) continue;
      const inDialog = cand.root !== document;
      if (inDialog || /\/status\/\d+/.test(location.pathname)) { c = cand; break; }
    }
    if (!c) throw new Error('回复框没弹出来（怕发成新推文，这条跳过）');

    return await fillAndSend(c, task.text, {
      send: !!task.send, typeMs: task.typeMs, checkMs: task.checkMs,
    });
  }

  /* ── 引用一条 ──
   * 比转推重得多：引用是**你自己发的一条帖**，永久留在主页上，
   * 原帖作者还会收到通知。转推写错了取消就没了，引用写错了删帖也没用。
   * 所以宁可少：一天一两个，文字必须真的有东西（质量闸在后台，这里只管发）。
   */
  async function doQuote(task) {
    await closeDialogs();

    /* 不做整页跳：引用发出去就是一条真帖，重复发等于主页上两条一样的，
     * 比漏发难看得多。翻不到就放过。 */
    const art = await locate(task.url, true);
    if (!art) throw new Error('这条推文翻不到了（引用不做整页跳，直接放过）');

    /* 引用前的停顿比转推更长：这是要公开表态的事，得真看完、真想清楚。 */
    await sleep(5000 + Math.random() * 6000);

    const art2 = findArticle(task.url) || art;

    /* 已经转过的话按钮是 unretweet，没有 retweet。
     * 千万别去点它 —— 那个菜单里第一项是「取消转推」，点错就是把转推翻回去。
     * 报 already 而不是「没有转推按钮」，后台才分得清「这条动过了」和「页面不对」。 */
    if (art2.querySelector('[data-testid="unretweet"]')) {
      return { ok: true, already: true };
    }

    const btn = art2.querySelector('[data-testid="retweet"]');
    if (!btn) throw new Error('这条没有转推按钮（可能是广告或纯转推）');

    btn.click();
    await sleep(800 + Math.random() * 700);

    /* 菜单第一项是「转推」，第二项是「引用」。
     * testid 不稳，所以三级兜底：testid → 文字 → 排掉转推后的第一个菜单项。 */
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    const repostItem = document.querySelector('[data-testid="retweetConfirm"]');
    const quoteItem =
      document.querySelector('[data-testid="quote"]') ||
      items.find((el) => el !== repostItem && /^(Quote|引用)/i.test((el.innerText || '').trim())) ||
      items.find((el) => el !== repostItem);

    if (!quoteItem) {
      document.body.click();
      await sleep(400);
      throw new Error('转推菜单里没找到「引用」');
    }

    quoteItem.click();
    await sleep(1600 + Math.random() * 1200);

    /* 引用一定是在弹窗里写的。找不到弹窗就收手 ——
     * 要是写进时间线顶部那个框，就变成一条没有引用的新推文了。 */
    let c = null;
    for (let i = 0; i < 20; i++) {
      const cand = findComposer();
      if (cand && cand.root !== document) { c = cand; break; }
      await sleep(500);
    }
    if (!c) {
      await closeDialogs();
      throw new Error('引用框没弹出来');
    }

    return await fillAndSend(c, task.text, {
      send: !!task.send, typeMs: task.typeMs, checkMs: task.checkMs,
    });
  }


  /* ── 转推一条 ──
   * 三个动作里最轻的一个：不用打字，一个按钮。
   * 但它是最强的背书 —— 转出去等于跟自己的粉丝说「这个值得看」。
   * 所以宁可少转：一天一两个，多了就成搬运号了。
   *
   * 真人转推前一定会读完：停下来、看完、再点。比回帖还慎重一点，
   * 因为回复是「我有话说」，转推是「这个你也该看」。
   */
  async function doRepost(task) {
    const art = await locate(task.url, true);
    if (!art) throw new Error('这条推文翻不到了（转推不做整页跳，直接放过）');

    /* 先读。转推前的停顿比回帖还长 —— 得真的看完才敢背书。 */
    await sleep(4000 + Math.random() * 6000);

    const art2 = findArticle(task.url) || art;

    /* 已经转过的别再点 —— 再点一次就是取消转推。 */
    if (art2.querySelector('[data-testid="unretweet"]')) {
      return { ok: true, already: true };
    }

    const btn = art2.querySelector('[data-testid="retweet"]');
    if (!btn) throw new Error('这条没有转推按钮（可能是广告或纯转推）');

    btn.click();
    await sleep(700 + Math.random() * 700);

    /* 菜单第一项是「转推 / Repost」，第二项是「引用」。
     * testid 是 retweetConfirm，但 X 偶尔改，所以再按文字兜一层。 */
    const confirm =
      document.querySelector('[data-testid="retweetConfirm"]') ||
      [...document.querySelectorAll('[role="menuitem"], [role="menu"] div[role="button"]')]
        .find((el) => /^(Repost|转推|转贴)/i.test((el.innerText || '').trim()));

    if (!confirm) {
      /* 菜单没弹出来就把菜单关掉，别留在页面上挡住下一条 */
      document.body.click();
      await sleep(400);
      throw new Error('转推菜单没弹出来');
    }

    confirm.click();
    await sleep(1600 + Math.random() * 1600);

    /* 验证：按钮得变成 unretweet 才算真转出去了 */
    const done = !!(findArticle(task.url) || art2).querySelector('[data-testid="unretweet"]');
    if (!done) throw new Error('点了转推但状态没变');

    return { ok: true };
  }

  /* 从主页回时间线：点左侧那个主页图标。真人也是这么回去的，不按浏览器后退。 */
  async function goBackHome() {
    const home = document.querySelector('[data-testid="AppTabBar_Home_Link"]') ||
                 document.querySelector('a[href="/home"]');
    if (home) {
      home.click();
      await sleep(1200 + Math.random() * 900);
    } else {
      history.back();
      await sleep(900);
    }
  }

  /* ── 回完帖顺手关注作者 ──
   * 真人不是"专门开个时间批量关注"，那是运营的干法。
   * 真人是：回完这条，瞄一眼自己发得对不对，觉得这号还行，
   * 点进主页翻两眼，关注，再回来接着刷。
   * 所以这个动作必须紧跟在回复后面，有停顿、有犹豫，点完就走反而假。
   *
   * 全程走 SPA 内部跳转（点作者名进主页、点主页图标回来），不刷页面。
   * 一旦整页跳，这条回复的结果就送不回去了，还会被当成失败重发。
   */
  async function followInline(handle, tweetUrl) {
    const h = String(handle || '').replace(/^@/, '').trim();
    if (!h) return { ok: false, why: '没拿到 handle' };

    try {
      /* 1. 先停一下。刚发完回复会瞄一眼，不会立刻跳走。 */
      await sleep(1200 + Math.random() * 2200);

      /* 2. 从那条推文上点作者名进主页。
       *    找不到就算了 —— 虚拟列表可能已经把它回收了，不值得为这个冒险。 */
      const art = findArticle(tweetUrl);
      const link = art && art.querySelector('[data-testid="User-Name"] a[href^="/"]:not([href*="/status/"])');
      if (!link) return { ok: false, why: '推文已被列表回收，找不到作者链接' };

      link.click();
      await sleep(1800 + Math.random() * 1200);

      /* 3. 等资料卡出来。
       *    一定先查 -unfollow：已关注的号上只有取消关注按钮。
       *    只看 userActions 那个容器，别误点右边「推荐关注」里的人。 */
      let btn = null;
      for (let i = 0; i < 25; i++) {
        const scope = document.querySelector('[data-testid="userActions"]') || document;
        if (scope.querySelector('[data-testid$="-unfollow"]')) {
          await goBackHome();
          return { ok: true, already: true, handle: h };
        }
        const fo = scope.querySelector('[data-testid$="-follow"]');
        if (fo) { btn = fo; break; }
        await sleep(400);
      }
      if (!btn) {
        await goBackHome();
        return { ok: false, why: '主页上没找到关注按钮' };
      }

      /* 4. 往下翻两下，像在看这个人平时发什么。
       *    点进来立刻点关注，跟点进去就走的机器没区别。 */
      window.scrollBy(0, 300 + Math.random() * 500);
      await sleep(2000 + Math.random() * 3500);

      const label = (btn.innerText || btn.getAttribute('aria-label') || '').trim();
      btn.click();
      await sleep(1400 + Math.random() * 900);

      /* 少数号会弹二次确认 */
      const dlg = document.querySelector('[role="dialog"]');
      if (dlg) {
        const okBtn = [...dlg.querySelectorAll('[role="button"], button')]
          .find((el) => /^(Follow|关注|确认)/.test((el.innerText || '').trim()));
        if (okBtn) { okBtn.click(); await sleep(800); }
      }

      /* 5. 验证：按钮得变成「正在关注 / 取消关注」才算真关注上。
       *    没变就是没成，不能在日志里报成功。 */
      let done = false;
      for (let i = 0; i < 8; i++) {
        if (document.querySelector('[data-testid$="-unfollow"]')) { done = true; break; }
        await sleep(400);
      }

      await goBackHome();
      if (!done) return { ok: false, why: '点了但状态没变（按钮写着「' + label + '」）' };
      return { ok: true, handle: h, requested: /请求|Request/i.test(label) };
    } catch (e) {
      /* 关注失败不能影响回复结果 —— 那条回复早就发出去了 */
      try { await goBackHome(); } catch (x) {}
      return { ok: false, why: (e && e.message) || String(e) };
    }
  }

  /* ── 收任务 ── */
  let busy = false;   // 正在做任务时不许乱滚，不然会把要操作的那条滑走

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'run') {
      const t = msg.task || {};
      busy = true;
      (async () => {
        try {
          if (t.type === 'fetch') {
            if (t.hard) {
              // 整页刷新：这个脚本会被销毁，先留记号，刷新完自己接着抓
              try {
                sessionStorage.setItem(RESUME_KEY, JSON.stringify({
                  id: t.id, type: 'fetch', limit: t.limit, tab: t.tab, seen: t.seen, at: Date.now(),
                }));
              } catch (e) {}
              location.reload();
              return; // 不响应，通道会随刷新断开
            }
            const items = await fetchTimeline(t.limit || 10, { tab: t.tab, refresh: t.refresh });
            sendResponse({ ok: true, data: items, ver: VER });
          } else if (t.type === 'reply') {
            try {
              sessionStorage.setItem(RESUME_KEY, JSON.stringify({
                id: t.id, url: t.url, text: t.text, send: !!t.send, at: Date.now(),
              }));
            } catch (e) {}

            let r = await doReply(t);

            /* 先清接力标记，再去做关注。
             * 关注那步要跳页面（正常是 SPA 内部跳，不刷页），
             * 万一真刷了，留着 RESUME_KEY 的 resume 会把这条回复再发一遍。 */
            try { sessionStorage.removeItem(RESUME_KEY); } catch (e) {}

            /* 发成功了、这条的作者也够格，就顺手关注一下。
             * 关注失败不影响回复结果 —— 那条回复早就出去了。
             *
             * 注意 else 那支：只要后台要了关注，就必须回一个明确结果。
             * 以前只在 r.sent 为真时才写 r.follow，其余情况什么都不写，
             * 后台拿到 null 只能写「页面没给结果」—— 把真正的原因吞掉了。 */
            if (t.followHandle) {
              if (r && r.sent) {
                r.follow = await followInline(t.followHandle, t.url);
              } else {
                r = r || {};
                r.follow = { ok: false, why: '这条回复没发出去，跳过关注' };
              }
            }
            sendResponse({ ok: true, data: r, ver: VER });
          } else if (t.type === 'humanize') {
            const r = await humanize(t);
            sendResponse({ ok: true, data: r, ver: VER });
          } else if (t.type === 'follow') {
            /* 这条不回帖，只关注作者。
             * 跟 reply 里那个顺手关注是同一个动作，区别只在于没有回复要发。 */
            const r = await followInline(t.handle, t.url);
            sendResponse({ ok: true, data: r, ver: VER });
          } else if (t.type === 'repost') {
            const r = await doRepost(t);

            /* 转完如果这个作者也够格，顺手关注。
             * 顺序不能反：转推要这条推文还在眼前，关注得跳去主页 ——
             * 先关注的话回来就得重新翻找这条，翻不到就整页跳，更假。 */
            if (r && r.ok && t.followHandle) {
              r.follow = await followInline(t.followHandle, t.url);
            }
            sendResponse({ ok: true, data: r, ver: VER });
          } else if (t.type === 'quote') {
            /* 引用：转推按钮 → 菜单里的「引用」→ 弹窗里写字 → 发。
             * 它发出去的是一条真帖，所以不接力、不整页跳、不做顺手关注 ——
             * 一条帖子里塞太多动作反而显眼。 */
            const r = await doQuote(t);
            sendResponse({ ok: true, data: r, ver: VER });
          } else {
            sendResponse({ ok: false, error: '未知任务类型: ' + t.type });
          }
        } catch (e) {
          try { sessionStorage.removeItem(RESUME_KEY); } catch (x) {}
          sendResponse({ ok: false, error: (e && e.message) || String(e) });
        } finally {
          busy = false;
        }
      })();
      return true; // 异步
    }

    if (msg && msg.type === 'ping') {
      sendResponse({ ok: true, url: location.href, ver: VER });
      return false;
    }
  });

  /* ── 页面整跳之后，把没做完的活接着做完 ── */
  (async function resume() {
    let job = null;
    try { job = JSON.parse(sessionStorage.getItem(RESUME_KEY) || 'null'); } catch (e) {}
    if (!job || !job.id) return;
    try { sessionStorage.removeItem(RESUME_KEY); } catch (e) {}
    if (Date.now() - (job.at || 0) > 180000) return; // 超过 3 分钟就不管了

    const report = (payload) => {
      chrome.runtime.sendMessage(
        Object.assign({ type: 'taskResult', id: job.id, url: job.url }, payload),
        () => void chrome.runtime.lastError,
      );
    };

    await sleep(2500);

    if (job.type === 'fetch') {
      try {
        const items = await fetchTimeline(job.limit || 10, {
          tab: job.tab,
          seen: job.seen,
          /* 这里也得往下传：页面跳转后接着抓的时候，同样需要「翻不到就软刷新」 */
          refresh: !!job.refresh,
        });
        report({ data: items });
      } catch (e) {
        report({ error: (e && e.message) || String(e) });
      }
      return;
    }

    try {
      const r = await doReply(job);
      report({ data: r });
    } catch (e) {
      report({ error: (e && e.message) || String(e) });
    }
  })();

  /* ── 心跳：让 background 一直活着去领活 ──
   * 顺便问一句「现在是不是在等间隔」——是的话页面就自己慢慢往下滑，
   * 别让页面钉在一条推文上僵两分钟，那比不动还假。
   */
  let nextBrowseAt = 0;
  let userTouchedAt = 0;   // 作者自己在翻/在打字的时候别抢方向盘

  const touched = () => { userTouchedAt = Date.now(); };
  ['wheel', 'mousedown', 'keydown', 'touchstart'].forEach((ev) => {
    window.addEventListener(ev, touched, { passive: true, capture: true });
  });

  function maybeBrowse() {
    if (busy) return;                                   // 正在回帖，别乱滚
    if (document.querySelector('[role="dialog"]')) return;  // 有弹窗开着，不动
    const now = Date.now();
    if (now - userTouchedAt < 25000) return;            // 作者刚动过，让给他
    if (now < nextBrowseAt) return;

    /* 间隔方差要够大：真人有时扫两眼就往下，有时盯着一条看两分钟。
     * 以前是固定 10~18 秒一次，太均匀了。 */
    const base = Math.random() < 0.12
      ? 40000 + Math.random() * 50000      // 偶尔走神
      : 8000 + Math.random() * 14000;      // 正常往下扫
    nextBrowseAt = now + base;

    /* 时间线基本都是往下看的，往回翻是少数情况。
     * 幅度也收小一点 —— 滚太远的话下一条还得翻回来找，反而更假。 */
    const dir = Math.random() < 0.82 ? 1 : -1;
    window.scrollBy(0, dir * (180 + Math.random() * 340));
  }

  /* 心跳是引擎的主驱动，但不能一直 1.5 秒一次。
   * 等「久」档那 40~90 分钟（或者跨夜的时间段）的时候，每 1.5 秒戳一次后台
   * 等于让扩展整夜醒着。后台会告诉还要等多久，等得久就放慢到 8 秒一次 ——
   * 到点最多晚 8 秒，反正还有 30 秒的闹钟兜底。 */
  let tickEvery = 1500;

  const tickOnce = () => {
    try {
      /* 顺便报一下自己是不是在前台。页面一旦不可见，浏览器就停掉渲染，
       * 时间线不再往下出新的 —— 面板上得能看出这个，
       * 不然作者只会看到「一直没反应」，猜不出是窗口被切走了。 */
      chrome.runtime.sendMessage({ type: 'tick', vis: document.visibilityState }, (resp) => {
        void chrome.runtime.lastError;
        if (resp) {
          if (resp.browse) maybeBrowse();
          tickEvery = resp.waitLeft > 120 ? 8000 : 1500;
        }
        setTimeout(tickOnce, tickEvery);
      });
    } catch (e) {
      setTimeout(tickOnce, tickEvery);
    }
  };

  setTimeout(tickOnce, tickEvery);
})();
