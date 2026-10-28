/* 回帖助手 v7 · background
 *
 * 全部逻辑（配置、调模型、循环调度、任务派发）都搬进扩展里跑：
 * 不用再开本地 Node 服务，也不用开网页，点图标开侧边栏就行。
 *
 * 为什么不是"一个 while 循环跑到死"：
 * MV3 的 service worker 空闲 30 秒就会被浏览器杀掉，长 sleep 靠不住。
 * 所以循环被写成一个存进 storage 的状态机（phase + nextAt），
 * 靠两个心跳推着走：
 *   ① 页面里 content script 每 1.5 秒发一次 tick（主驱动，顺便保活）
 *   ② chrome.alarms 每 30 秒一次（备用：标签页被切到后台、tick 被节流时兜底）
 * worker 被杀掉也不怕，下次醒来从 storage 里读回断点接着跑。
 */

const VER = 'v25';

const DEF_PERSONA = `账号「猫大人」，码农，只做现货，从没开过合约。写币圈亏钱经历，不喊单、不给点位。

写回复的铁律（违反即废）：
1. 不要 AI 味。禁止对仗排比（X看A，Y看B，Z看C）、禁止"不是……而是……"这种对偶、禁止工整的金句收尾、禁止用破折号做解释。
2. 句子长短不齐。可以用口语词：其实、说实话、就、反正、大概、哈哈。
3. 每条 60 字以内，能短就短。
4. 不用堆标点，可以用空格断句。
5. 不喊单。不说看涨看跌、不给目标价、不建议买或卖。
6. 不提合约、杠杆、爆仓。
7. 不要"说得好""有道理""感谢分享"这种空话开头，也不复述原帖内容。

写法：先在原帖里找一个最值得接的点——一个数字、一个逻辑漏洞、一个没说出口的前提、或者作者自己的自嘲——然后只回应那一个点，别贪多。`;

const DEF_CONFIG = {
  base: 'https://api.deepseek.com',   // 默认就用 DeepSeek，改别的服务商再动
  key: '', model: 'deepseek-chat', persona: DEF_PERSONA,
  limit: 10,
  tabLabel: '加密',
  /* ── 会话制 ──
   * 真人不是"每 5 分钟回一条"这样均匀铺开的，是一段一段：
   * 坐下刷一阵（回几条），然后走开，回来再坐下。
   * 时间分布成簇，才是人的形状。 */
  sessMin: 4, sessMax: 9,        // 一次坐下回几条
  /* 这一段里两条之间隔几秒 —— 这是「上一条发完，滑到这一条」的时间，
   * 不含读帖和打字（那两段现在按内容量单独算，见 humanTiming）。
   * 以前是 80~170 秒，其实是用空白凑真实感：真人不会对着屏幕发呆两分半
   * 再去读一条，他就是滑了几条才碰到这条。 */
  stepMin: 30, stepMax: 70,
  awayMin: 15, awayMax: 45,      // 走开多久（分钟），和刚坐的时长正相关
  human: true,
  dailyMax: 60,
  /* 一轮抓 10 条，但不是每条都回 —— 全回太整齐，容易像机器。
   * 固定就是"挑几条回"，没有"全部回"和"只刷新"了：
   * 那两个模式一个是测试用、一个是养号用，日常只会误点。 */
  pickMin: 1, pickMax: 3,
  screen: true,     // 挑之前先让模型看一眼，挑有话可接的（关掉就是纯随机挑）
  windows: '',      // 只在几个时间段跑，留空 = 全天都能跑
  timelineUrl: 'https://x.com/home',

  /* ── 自动关注 ──
   * 全自动的东西必须留够余量：门槛卡死、日限额压住、失败就放弃。
   * 关注跟回复是两件独立的事，判断也分开（模型给两个不同的分）。 */
  autoFollow: true,
  followDaily: 40,        // 一天最多关注几个。30~50 是安全区间
  followMinScore: 2,      // 模型打到几分才关注（0~3，2 = 明确值得）
  followMaxReplies: 150,  // 回复数超过这个 = 大V帖，关注了也不会有任何互动
  followMaxLikes: 3000,

  /* ── 偶尔转推 / 偶尔引用 ──
   * 一个币圈号一个都不转，比转得多还显眼。但这两个动作都是在拿自己的信用背书。
   *
   * 区别：
   *   转推 = 「这个你也该看」，粉丝自己去看，你不用表态。
   *   引用 = 你自己发一条帖，永久留在主页上，原帖作者还会收到通知。
   * 所以引用的门槛比转推高一层：只有「真的有一句别人说不出的话」才引。
   *
   * 数量上作者的原话是「一天 1~2 个撑死」。这里不是固定配额 ——
   * 每天开局现抽一个 0~N 的数，抽到 0 就那天一个都不转不引。
   * 固定配额会让「每天正好 2 个」变成规律，随机才有「有时候今天不想转」的人味。 */
  autoRepost: true,
  repostDaily: 2,        // 转推：每天从 0~这个数里抽一个
  autoQuote: true,
  quoteDaily: 3,         // 引用：每天从 0~这个数里抽一个
  quoteMaxReplies: 150,  // 回复数超过这个就不引用了 —— 大V帖引了也是石沉大海，还容易被看成蹭
};

const DEF_STATE = {
  sentToday: 0, dayKey: '', sentUrls: [], seenUrls: [],
  /* 关注单独记账：跟回复的日限额互不影响，一天关注到量了就停。
   * followLog 只记不删 —— 取关由作者自己手动做，程序不碰。
   * followFail 记失败次数：失败也要记账，不然同一个号每轮都会被再试一次。 */
  followToday: 0, followDayKey: '', followLog: [], followFail: {},
  /* 转推也单独记账。repostLog 记的是 url，用来防止同一条转两次
   * （再点一次就是取消转推，比不转还糟）。
   * repostTarget 是今天抽到的配额（0~repostDaily），-1 = 今天还没抽。 */
  repostToday: 0, repostDayKey: '', repostLog: [], repostTarget: -1,
  /* 引用同理。quoteLog 里多存一份正文 —— 引用是永久帖，
   * 作者回头要能看见「程序到底替我发了什么」。 */
  quoteToday: 0, quoteDayKey: '', quoteLog: [], quoteTarget: -1,
};

const DEF_LOOP = {
  running: false, dryRun: false, limit: 10,
  round: 0, sent: 0, fail: 0,
  phase: 'idle',   // idle | fetch | reply | wait | away | window
  nextAt: 0,       // 到这个时间点之前不动（等间隔 / 走开）
  idx: 0,          // batch 里处理到第几个
  batch: [],       // [{author,text,url,reply,state}]
  log: [],
  styleIdx: 0,
  retry: {},       // url -> 失败次数
  retryFetch: 0,   // 连续抓取失败几次（用来退避，别每 15 秒刷一次屏）
  /* 会话：坐下 → 回够几条 → 走开 → 回来 */
  sessionTarget: 0,     // 这一段打算回几条（坐下时抽）
  sessionDone: 0,       // 这一段已经回了几条
  sessionStartAt: 0,    // 这一段什么时候坐下的（用来算坐多久）
  emptyRounds: 0,       // 这一段连续几批没挑出东西（连着几次就该起身了）
  emptyFetches: 0,      // 连续几批抓回来全是看过的（页面可能没在渲染新内容）
  seenThisRun: [], // 本轮抓过的（试运行不写 sentUrls，得自己记着别重复）
  /* {url, at, kind, tmo} 正在派给页面的那条，防 worker 被杀后重复派。
   * kind 是 reply / quote / repost —— 三个动作都可能跑几分钟，
   * 崩在哪一步，重启后得知道这条到底是「待回」「引用中」还是「只转推」。
   * tmo 是这一条自己的超时上限，过期判定按它算，不用固定值。 */
  inflight: null,
};

/* ────────────── 存储 ────────────── */

const CACHE = { cfg: null, st: null, lp: null, vis: null };

async function readCfg() {
  const o = await chrome.storage.local.get('cfg');
  const c = Object.assign({}, DEF_CONFIG, o.cfg || {});
  /* 以前存过空地址的，直接补上默认值，省得作者还要自己填一遍 */
  if (!String(c.base || '').trim()) c.base = DEF_CONFIG.base;
  return c;
}
async function readSt() {
  const o = await chrome.storage.local.get('st');
  const s = Object.assign({}, DEF_STATE, o.st || {});
  if (!Array.isArray(s.sentUrls)) s.sentUrls = [];
  if (!Array.isArray(s.seenUrls)) s.seenUrls = [];
  if (!Array.isArray(s.followLog)) s.followLog = [];
  if (!s.followFail || typeof s.followFail !== 'object') s.followFail = {};
  if (!Array.isArray(s.repostLog)) s.repostLog = [];
  if (!Array.isArray(s.quoteLog)) s.quoteLog = [];
  if (s.repostTarget == null) s.repostTarget = -1;
  if (s.quoteTarget == null) s.quoteTarget = -1;
  return s;
}
async function readLp() {
  const o = await chrome.storage.local.get('lp');
  return Object.assign({}, DEF_LOOP, o.lp || {});
}

async function cfg() { if (!CACHE.cfg) CACHE.cfg = await readCfg(); return CACHE.cfg; }
async function st() { if (!CACHE.st) CACHE.st = await readSt(); return CACHE.st; }
async function lp() { if (!CACHE.lp) CACHE.lp = await readLp(); return CACHE.lp; }

async function saveCfg(c) { CACHE.cfg = c; await chrome.storage.local.set({ cfg: c }); }
async function saveSt(s) {
  CACHE.st = s;
  await chrome.storage.local.set({
    st: {
      sentToday: s.sentToday, dayKey: s.dayKey,
      sentUrls: s.sentUrls.slice(-500),
      seenUrls: s.seenUrls.slice(-3000),
      followToday: s.followToday || 0, followDayKey: s.followDayKey || '',
      followLog: (s.followLog || []).slice(-800),
      followFail: s.followFail || {},
      repostToday: s.repostToday || 0, repostDayKey: s.repostDayKey || '',
      repostLog: (s.repostLog || []).slice(-400),
      repostTarget: s.repostTarget == null ? -1 : s.repostTarget,
      quoteToday: s.quoteToday || 0, quoteDayKey: s.quoteDayKey || '',
      quoteLog: (s.quoteLog || []).slice(-200),
      quoteTarget: s.quoteTarget == null ? -1 : s.quoteTarget,
    },
  });
}
async function saveLp(l) {
  CACHE.lp = l;
  const keep = l.log.slice(-120);
  await chrome.storage.local.set({ lp: Object.assign({}, l, { log: keep }) });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ────────────── 小工具 ────────────── */

/* 间隔不是固定值：在 [min, max] 里随机，中间值更常见（三角分布） */
function pickGap(min, max) {
  const lo = Math.max(1, +min || 25);
  const hi = Math.max(lo, +max || 80);
  if (hi === lo) return lo;
  const u = (Math.random() + Math.random()) / 2;
  return Math.round(lo + u * (hi - lo));
}

/* ── 会话制：一段一段地刷，不是均匀铺开 ──
 *
 * 真人刷推的形状是"成簇"的：坐下刷十几二十分钟回几条，然后走开半小时到一小时，
 * 回来再坐下。一天下来是几段密集 + 几段空白。
 *
 * 旧的做法是"每条之间抽一个间隔"，每条独立 —— 数学上叫独立同分布，
 * 长期看就是均匀铺满整晚，那反而是最不像人的形状（人不可能一直在）。
 *
 * 现在的结构：
 *   坐下 → 回 4~8 条（条间隔 1.5~3 分钟）→ 走开 15~45 分钟 → 回来坐下
 *
 * 校准过的账（平均）：
 *   一段 = 6 条 × (2.25 分间隔 + 0.5 分动作) ≈ 16.5 分钟
 *   走开 ≈ 30 分钟（坐得越久走得越久）
 *   周期 ≈ 46.5 分钟回 6 条 → 平均 7.75 分钟一条
 *   → 6 小时约 45 条，9 小时跑满 60（撞日上限）
 */

/* 这一次坐下打算回几条 */
function pickSessionCount(c) {
  c = c || {};
  const lo = Math.max(1, Math.round(+c.sessMin || 4));
  const hi = Math.max(lo, Math.round(+c.sessMax || 9));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/* 这一段里，两条之间隔几秒。三角分布，中间值更常见 —— 人不会每次都卡着两端 */
function pickStepSec(c) {
  c = c || {};
  const lo = Math.max(20, Math.round(+c.stepMin || 80));
  const hi = Math.max(lo, Math.round(+c.stepMax || 170));
  return pickGap(lo, hi);
}

/* 走开多久（分钟）。
 * 和刚坐的时长正相关：坐得越久，越可能抽到靠近上限的那一头。
 * 但结果永远不超出 [awayMin, awayMax] —— 面板上写的是 15~45，
 * 跑出来 65 就是骗人。（之前是在区间外再加一段，界面和实际对不上。） */
function pickAwayMin(c, sessMin) {
  c = c || {};
  /* 下限跟 sanitizeCfg 对齐（3 分钟）。以前这里写 5，
   * 作者填 3 实际跑 5，界面上说的和跑的就不是一回事了。 */
  const lo = Math.max(3, Math.round(+c.awayMin || 15));
  const hi = Math.max(lo, Math.round(+c.awayMax || 45));
  if (hi === lo) return lo;
  const w = Math.min(1, Math.max(0, sessMin) / 20);   // 坐满 20 分钟就算"坐久了"
  /* u 的分布：w=0 时均匀；w=1 时往 1 那头偏（平方根）。中间值连续过渡 */
  const u = Math.pow(Math.random(), 1 / (1 + 2 * w));
  return Math.round(lo + u * (hi - lo));
}

/* 秒数写成好读的样子：95 → 1 分 35 秒 */
function fmtSec(s) {
  s = Math.round(s);
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? (m + ' 分 ' + r + ' 秒') : (m + ' 分钟');
}

/* 一轮抓一批，但只回其中随机几条。
 * 打乱是 Fisher-Yates，取前 n 条；n 在 [pickMin, pickMax] 里随机。 */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickCount(min, max, total) {
  const lo = Math.max(1, +min || 1);
  const hi = Math.max(lo, +max || 3);
  const n = lo + Math.floor(Math.random() * (hi - lo + 1));
  return Math.min(total, n);
}

/* ── 运行时间段 ──
 * windows 留空 = 全天都能跑。填了就只在窗口里发：
 *   09:00-11:00,13:00-14:30,20:00-23:00
 * 支持跨零点（22:00-02:00）。 */
function parseWindows(str) {
  const out = [];
  String(str || '').split(/[,，;；\s]+/).forEach((seg) => {
    const m = seg.match(/^(\d{1,2}):(\d{2})\s*[-~到]\s*(\d{1,2}):(\d{2})$/);
    if (!m) return;
    const a = (+m[1]) * 60 + (+m[2]);
    const b = (+m[3]) * 60 + (+m[4]);
    if (a === b) return;
    out.push({ a, b });
  });
  return out;
}

function inWindows(wins, d) {
  if (!wins.length) return true;
  const cur = d.getHours() * 60 + d.getMinutes();
  return wins.some((w) => (w.a < w.b ? (cur >= w.a && cur < w.b) : (cur >= w.a || cur < w.b)));
}

/* 距离下一个窗口开始还有多少毫秒，已经在窗口里就是 0 */
function msToWindow(wins, d) {
  if (!wins.length || inWindows(wins, d)) return 0;
  const cur = d.getHours() * 60 + d.getMinutes();
  let best = 1440;
  for (const w of wins) {
    let diff = w.a - cur;
    if (diff <= 0) diff += 1440;
    if (diff < best) best = diff;
  }
  return best * 60000;
}

/* ── 规则先筛一遍 ──
 * 抽奖、空投、返佣、太短、纯链接这些不用问模型，直接跳过。
 * 省一次调用，也省得模型对着广告硬写。 */
const BAD_TEXT = /抽奖|抽\s*\d+\s*人|空投|白名单|领取|注册|返佣|邀请码|开奖|airdrop|giveaway|whitelist|referral|presale|加群|私信/i;

function looksBad(text) {
  const t = String(text || '').trim();
  if (t.length < 15) return true;                    // 太短，没内容可接
  if (BAD_TEXT.test(t)) return true;                 // 广告 / 抽奖 / 拉人
  if (/^https?:\/\//.test(t)) return true;           // 纯链接
  const cjk = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (cjk === 0 && t.length < 40) return true;       // 没有中文又很短，多半是项目方通告
  return false;
}

/* ── 让模型先看一遍这批帖子 ──
 * 一次调用出三个**互相独立**的判断：
 *   why/angle  → 这条值不值得回、从哪接
 *   f          → 这个**人**值不值得关注（跟回不回复没关系）
 *   r          → 这条**内容**要不要动它（3=引用、2=转推、1=不动、0=垃圾）
 * 分开是有意的：有的帖子回了也不关注，有的帖子没话说但作者想跟，
 * 还有的帖子不值得回、作者也不用跟，但内容本身值得让粉丝看见。
 * 三件事混成一个分，就会变成"回了就关注""关注了就转"那种机械行为。
 *
 * 为什么引用和转推共用一个分：它们本来就是同一个问题的两端 ——
 * 「我有没有实质的东西可以加」。分成两个分，模型会在同一条上同时给
 * 「该转」和「该引」，代码里还得再判一次优先级，纯属自找麻烦。
 */
async function screenPosts(items, c) {
  const n = pickCount(c.pickMin, c.pickMax, items.length);

  /* 把作者和互动数一起给模型 —— 判断"这个人"需要这些，
   * 只看正文会把它变成"这条写得好不好"。 */
  const lines = items.map((x, i) => {
    const who = (x.author || '') + (x.handle ? ' @' + x.handle : '');
    const stat = '回' + (x.replies || 0) + ' 赞' + (x.likes || 0);
    const body = String(x.text || '').replace(/\s+/g, ' ').slice(0, 160);
    return (i + 1) + '. [' + who.trim() + ' | ' + stat + '] ' + body;
  }).join('\n');

  const prompt = '【挑帖】下面是时间线上的 ' + items.length + ' 条帖子，编号从 1 开始。\n' +
    '要做三个独立的判断。\n' +
    '\n' +
    '一、值不值得回（最多 ' + n + ' 条）：有具体观点、数字、情绪或自嘲可以接；\n' +
    '   纯广告、纯喊单、没内容的不要。值得回就给 why 和 angle。\n' +
    '\n' +
    '二、这个作者值不值得关注（每条都要给，跟回不回复完全无关）：\n' +
    '   f=3 以后还想看他发的东西，想长期跟\n' +
    '   f=2 有点意思，可以跟\n' +
    '   f=1 说不上\n' +
    '   f=0 广告号、喊单号、机构号、纯搬运、没有自己的观点\n' +
    '   看的是「这个人」不是「这条帖子」：是不是真人、有没有一手经历和自己的判断、\n' +
    '   是不是天天发广告或喊单、内容对不对得上现货和链上研究这条路。\n' +
    '\n' +
    '三、这条内容要不要动它（每条都要给，跟上面两个都无关）：\n' +
    '   r=3 值得引用：内容够硬，而且你确实有一句别人说不出的话可以加\n' +
    '       （自己的判断、自己踩过的坑、一个具体数字或时间点）\n' +
    '   r=2 值得转推：内容够硬，但你说不出什么新的，让粉丝自己看就行\n' +
    '   r=1 不动它\n' +
    '   r=0 广告、喊单、抽奖、纯情绪、纯搬运、拉人进群，转了引了都是自砸招牌\n' +
    '   分清楚这两个：引用是**你自己发一条帖**，永久留在主页上，原作者会收到通知；\n' +
    '   转推只是让粉丝自己去看，你不用表态。所以只有「真的有一句别人说不出的话」\n' +
    '   才配 3 分，只是觉得「写得不错」就给 2。宁可给 2，不要凑 3。\n' +
    '\n' +
    '注意：三个判断彼此独立。一条帖子可能不值得回但内容值得转，\n' +
    '也可能回得挺好但转出去丢人。\n' +
    '一条都不值得回就只输出带 f 和 r 的条目，不要凑 why。\n' +
    '只输出 JSON，不要任何解释：\n' +
    '[{"i":3,"why":"这条哪里可以接","angle":"从什么角度接","f":3,"r":0},{"i":7,"f":0,"r":3}]\n\n' + lines;

  const raw = await callModel(prompt, {
    system: '你是一个挑剔的币圈老哥。挑帖宁可少挑不要凑数；看人看的是长期产出，不是单条爆款；看要不要转，看的是这条转出去会不会让自己掉价。只输出 JSON。',
    temperature: 0.4,
    maxTokens: 900,
  });

  const s = String(raw || '');
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a < 0 || b <= a) throw new Error('模型没按格式回');

  const arr = JSON.parse(s.slice(a, b + 1));
  if (!Array.isArray(arr)) throw new Error('模型回的不是数组');

  const out = [];
  for (const it of arr) {
    const idx = (+it.i || 0) - 1;
    if (!(idx >= 0 && idx < items.length)) continue;
    const url = items[idx].url;
    const f = Math.max(0, Math.min(3, +it.f || 0));
    const r = Math.max(0, Math.min(3, +it.r || 0));
    const why = String(it.why || '').slice(0, 60);
    const angle = String(it.angle || '').slice(0, 40);

    /* 同一个编号可能被模型写两遍（一条管回、一条管关注/转推），合并成一条。
     * f 和 r 取高的那个 —— 它愿意为哪一头单独再写一遍，说明这头它更有把握。 */
    const ex = out.find((o) => o.url === url);
    if (ex) {
      if (why && !ex.why) { ex.why = why; ex.angle = angle; }
      if (f > ex.f) ex.f = f;
      if (r > ex.r) ex.r = r;
    } else {
      out.push({ url, why, angle, f, r });
    }
  }
  return out;
}

/* ── 本地硬门槛：不花模型 token 就能毙掉的 ──
 * 全自动关注没有人在旁边把关，所以这里宁可错杀。
 * 注意这里筛的是「值不值得关注」，不是「值不值得回」。
 */
function followWorthy(it, c) {
  if (!it.handle) return false;
  if (it.via) return false;                        // 转推/回复带出来的，不是本人发在时间线上
  const r = +it.replies || 0;
  const k = +it.likes || 0;
  if (r < 1 && k < 3) return false;                // 死号，或者刚发出来没人看
  if (r > (+c.followMaxReplies || 150) || k > (+c.followMaxLikes || 3000)) return false;
  return true;
}

/* 这个号现在还能不能关注：开关开着、没到日限额、以前没关注过、最近没连着失败。
 * 关注是单向不可逆的社交动作，宁可不做也别做错。 */
function canFollow(handle, s, c) {
  if (!c.autoFollow) return false;
  const h = String(handle || '').replace(/^@/, '').toLowerCase();
  if (!h) return false;
  if ((s.followToday || 0) >= c.followDaily) return false;
  if ((s.followLog || []).some((x) => String(x.h).toLowerCase() === h)) return false;
  /* 连着失败两次的，24 小时内别再碰。
   * 以前只记成功的，失败的下轮还会再试 —— 实测同一个号连着两轮各失败一次，
   * 白占两个名额；要是永久性失败（handle 不对、对方私密），会一直试下去。 */
  const ff = s.followFail && s.followFail[h];
  if (ff && (ff.n || 0) >= 2 && Date.now() - (ff.at || 0) < 86400000) return false;
  return true;
}

/* 记一笔关注失败。只留最近 7 天的，不然这张表会一直长。 */
async function markFollowFailed(handle, s) {
  const h = String(handle || '').replace(/^@/, '').toLowerCase();
  if (!h) return;
  if (!s.followFail || typeof s.followFail !== 'object') s.followFail = {};
  const prev = s.followFail[h] || {};
  s.followFail[h] = { at: Date.now(), n: (prev.n || 0) + 1 };
  const cut = Date.now() - 7 * 86400000;
  for (const k of Object.keys(s.followFail)) {
    if ((s.followFail[k].at || 0) < cut) delete s.followFail[k];
  }
  await saveSt(s);
}

/* 记一笔关注。取关由作者自己手动做，这里只负责记下来，
 * 好让面板能算出「关注满 7 天还没什么动静」的号提醒他清理。 */
async function markFollowed(handle, s, why) {
  const h = String(handle || '').replace(/^@/, '');
  s.followToday = (s.followToday || 0) + 1;
  if (!Array.isArray(s.followLog)) s.followLog = [];
  s.followLog.push({ h, at: Date.now(), why: String(why || '').slice(0, 40) });
  if (s.followLog.length > 800) s.followLog = s.followLog.slice(-800);
  await saveSt(s);
}

/* 关注一个人 —— 这条帖子不回，只关注。
 * 真人看到一条有意思的东西，可能没话说，但会点进主页看一眼再关注。 */
async function doFollowTask(handle, url, s, c, why) {
  const h = String(handle || '').replace(/^@/, '');
  if (!canFollow(h, s, c)) return { ok: false, skipped: true };

  await log('顺手关注 @' + h + '：' + (why || ''));
  let r = null;
  try {
    r = await dispatch({ type: 'follow', handle: h, url }, 90000);
  } catch (e) {
    await log('  关注没成：' + e.message);
    await markFollowFailed(h, s);
    return { ok: false };
  }

  const d = r || {};
  if (d.already) { await log('  本来就是关注状态'); return { ok: false, already: true }; }
  if (!d.ok) {
    await log('  关注没成：' + (d.why || '页面没给结果'));
    await markFollowFailed(h, s);
    return { ok: false };
  }

  await markFollowed(h, s, why);
  await log('  关注成功（今日第 ' + (s.followToday || 0) + ' 个）' +
            (d.requested ? '，对方是受保护账号，只发了请求' : ''));
  return { ok: true };
}

/* ── 本地硬门槛：这条值不值得引用 ──
 * 引用比转推更狠 —— 它是你自己发的一条帖，永久留在主页上。
 * 所以门槛在转推的基础上再加两条：太短的不引（引一段 20 个字的东西很怪），
 * 大V帖不引（回复数太多，引了也是石沉大海，还容易被看成蹭）。
 */
function quoteWorthy(it, c) {
  if (it.via) return false;                        // 转推/回复带出来的不是原创
  const t = String(it.text || '').trim();
  if (t.length < 30) return false;                 // 太短，撑不起一条引用的分量
  if (/^https?:\/\//.test(t)) return false;
  if (/(空投|抽奖|白名单|进群|加V|返佣|注册就送)/i.test(t)) return false;

  const r = +it.replies || 0;
  const k = +it.likes || 0;
  if (r < 1 && k < 5) return false;
  if (r > (+c.quoteMaxReplies || 150)) return false;
  return true;
}

/* 这条现在能不能引：开关开着、今天抽到的配额还没用完、以前没引过。 */
function canQuote(url, s, c) {
  if (!c.autoQuote) return false;
  if (!url) return false;
  const quota = s.quoteTarget == null ? 0 : +s.quoteTarget;
  if ((s.quoteToday || 0) >= quota) return false;
  if ((s.quoteLog || []).some((x) => x.u === url)) return false;
  return true;
}

/* 记一笔引用。这里多存一份正文 —— 引用是永久帖，
 * 作者回头必须能看见「程序到底替我发了什么话」。 */
async function markQuoted(url, s, handle, text) {
  s.quoteToday = (s.quoteToday || 0) + 1;
  if (!Array.isArray(s.quoteLog)) s.quoteLog = [];
  s.quoteLog.push({
    u: url, h: String(handle || '').replace(/^@/, ''),
    at: Date.now(), text: String(text || '').slice(0, 200),
  });
  if (s.quoteLog.length > 200) s.quoteLog = s.quoteLog.slice(-200);
  await saveSt(s);
}

/* ── 引用文字的质量闸 ──
 * 这是整个功能里最要紧的一段。
 *
 * 引用是**永久内容**，所以合格率不能是「大部分时候管用」——
 * 一条 AI 味的话挂在主页上，删了也已经被截图了。
 * 光靠 prompt 拦不住（回帖那边实测就是「多数时候管用」），
 * 所以这里做机械检查：命中任何一条就打回去重写，两次都不合格就放弃这条。
 * 宁可少发一条，也不发一条 AI 味的永久帖。
 *
 * 检查的都是「一眼能看出来」的东西，不做模糊判断 ——
 * 比如排比对仗就没法用代码可靠地认（他的文风本来就是短句不齐，
 * 按句长判断会误伤好句子），那条交给 prompt 和重写来兜。
 */
function quoteProblems(text, postText) {
  const t = String(text || '').trim();
  if (!t) return ['空的'];
  const bad = [];

  const xl = xlen(t);
  /* 60 权重 ≈ 30 个汉字。prompt 要的是 40~90 字，这里放宽一档当兜底 ——
   * 但不能更低：二十个字的一句话挂在主页上，撑不起一条永久帖。 */
  if (xl < 60 || xl > 280) bad.push('长度 ' + xl + '（要 60~280）');

  /* 红线。引用是永久的，这条比什么都重要。 */
  if (/(看涨|看跌|目标价|止损|抄底|梭哈|上车|合约|杠杆|爆仓|强平|点位|加仓)/.test(t)) {
    bad.push('碰了红线（喊单/点位/合约）');
  }

  /* AI 腔。这几条都是"人不会这么说话"的硬特征。 */
  if (/不是[^，。！？]{1,20}[，,]\s*而是/.test(t)) bad.push('「不是…而是」');
  if (/(说白了|本质上|归根结底|值得注意的是|总的来说|综上|由此可见)/.test(t)) bad.push('套话');
  if (/——|--/.test(t)) bad.push('破折号做解释');
  if (/[？?]\s*$/.test(t)) bad.push('问句收尾（互动钓饵）');
  if (/^(说得好|有道理|感谢分享|确实|同意|支持|学习了|受教)/.test(t)) bad.push('空话开头');
  if (/^(关于|对于|就着|借着).{2,14}[，,].{0,8}(我认为|我觉得|我想说|我想讲)/.test(t)) {
    bad.push('作文腔开头');
  }

  /* 话题标签一个都不要。币圈真人很少用 #，用了一看就是营销号 / 空投号。
   * $ 和 @ 是可以用的（作者明确要保留），这里不拦。
   * 裸一个 #（后面是空格或结尾）也要拦 —— 光判 `#+字母` 会漏掉它。 */
  if (/#[\p{L}\p{N}_]|#(?=\s|$)/u.test(t)) bad.push('用了 # 话题标签');

  /* 复述原帖：生成的话里只要出现原帖连续 8 个字，就是在复述。
   * 8 个字足够避开「提到同一个币种」这种正常重合。 */
  const src = String(postText || '').replace(/\s+/g, '');
  const mine = t.replace(/\s+/g, '');
  for (let i = 0; i + 8 <= src.length; i++) {
    if (mine.includes(src.slice(i, i + 8))) { bad.push('复述了原帖'); break; }
  }

  /* 实质锚点：数字 / 自己的经历 / 具体标的，一个都没有就是空话。
   * 这条是「必须实质性」的机械版 —— 光在 prompt 里写「要有实质」没用。 */
  const anchor = /\d/.test(t) ||
    /(我|自己|账户|仓位|现货|上次|当年|去年|那会儿|手上)/.test(t) ||
    /\$[A-Za-z]{2,}/.test(t);
  if (!anchor) bad.push('没有实质内容（数字 / 自己的经历 / 具体标的 一个都没有）');

  return bad;
}

/* 引用正文的提示词。比回帖严得多：它要独立成立，而且会被永久看到。
 *
 * 为什么这里要给例子，而不是继续堆「不许这样」：
 * 闸门那 6 条禁令光写在 prompt 里没用 —— 否定句一多，模型就当背景噪音跳过去了。
 * 模型对「照着这个语气写」的服从度，比对「别用破折号」高得多。
 * 所以真正干活的是例一：它把「有仓位、有数字、有判断」这件事**示范**了一遍，
 * 后面那串禁令只是兜底。
 *
 * 例一必须自己过得了闸 —— 例子自己都不合格，模型学到的就是错的。
 * 自检里有一条专门把这段抽出来跑 quoteProblems，改例子改坏了会直接红。 */
function buildQuotePrompt(row, fix) {
  return `原帖：
"""
${row.text}
"""
${row.why ? '可接的点：' + row.why : ''}
${row.angle ? '角度：' + row.angle : ''}
${fix ? '\n上一版被打回了：' + fix + '\n重写，别犯同样的问题。\n' : ''}
你要引用这条，加一段话发到自己的时间线上。看的人会同时看到原帖和你的话。

怎么写：
1. 说给**自己的粉丝**听，不是回给原作者。不要「你说得对」「补充一点」这种接话腔。
2. 必须有一句别人说不出的话：你自己的判断、你踩过的坑、一个具体数字或时间点。
3. 40~90 字，两三句，能独立成立。
4. 不要复述原帖，也不要总结它。
5. 可以用 $ 标币种（比如 $PEPE），可以用 @ 提人，但只提原帖作者或正文里真的提到的人，
   不要 @ 无关的大V蹭曝光。
6. 不喊单：不说看涨看跌、不给目标价和点位、不劝人买卖。
7. 不提合约、杠杆、爆仓。

例一（合格，学这个语气）：
「我现货里 $PEPE 那部分还套着，三万变一万二，等了两周也没见反转，这个数据我信一半」
自己的仓位 + 具体数字 + 一句判断，三样都有，读起来像随手打的。

例二（不合格，会被打回）：
「说白了，这不是数据的问题，而是节奏的问题——本质上还是情绪在定价，你怎么看？」
套话 + 对偶句 + 破折号 + 问句收尾，一句实质信息都没有。

例子只示范语气和结构，别抄里面的标的、数字和说法。

下面这些「一眼就看得出不是人写的」，一条都不许有 —— 写了直接打回重写：
· 不要用 # 话题标签，一个都不要。
· 不要用「不是……，而是……」这种对偶句。
· 不要用套话：说白了、本质上、归根结底、值得注意的是、总的来说、综上、由此可见。
· 不要用破折号（—— 或 --）去解释前半句，一句话说完就完了。
· 结尾不要用问句，尤其不要「你怎么看？」这种钓互动的。
· 开头不要「说得好 / 有道理 / 感谢分享 / 确实 / 同意 / 支持 / 学习了 / 受教」。
· 开头不要「关于……，我认为」「对于……，我觉得」这种作文腔。

落笔前自己过一遍：有没有 #、有没有破折号、结尾是不是问句、有没有复述原帖、
里面有没有一个具体数字或自己的经历。有一条不合格就重写。

输出要求：只输出这一段正文。不要解释、不要引号、不要编号、不要换行分段。`;
}

/* 生成一段引用正文：写 → 过闸 → 不合格就带着问题重写一次 → 还不行就放弃。
 * 返回 {ok, text, attempt} 或 {ok:false, bad} / {ok:false, err}。 */
async function makeQuote(row, c) {
  let fix = '';
  let last = '';
  let lastBad = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw = '';
    try {
      raw = await callModel(buildQuotePrompt(row, fix), {
        system: c.persona || DEF_PERSONA,
        /* 第二遍降点温度：它已经知道哪里不对了，别再到处乱试 */
        temperature: attempt === 1 ? 1.05 : 0.85,
        maxTokens: 500,
      });
    } catch (e) {
      return { ok: false, err: e.message };
    }
    /* 引用只有一段正文，不能只取第一块 —— parseBlocks 在空行处会切，
     * 模型偶尔会把一句话写成两段，取第一段就是发一条被腰斩的句子出去，
     * 而且它**不会报错**（第一段只要够长、带个数字就能过闸）。
     * 拼起来要是超长了，闸门会按长度打回，那比静默截断好得多。 */
    const text = parseBlocks(raw).join('').trim();
    const bad = quoteProblems(text, row.text);
    if (!bad.length) return { ok: true, text, attempt };
    last = text;
    lastBad = bad.join('、');
    fix = lastBad + '。';
  }
  return { ok: false, bad: lastBad, text: last };
}

/* 引用一条。这条不回帖 —— 引用填的是「内容够硬，而且我有话要说」这个空档。 */
async function doQuoteTask(row, s, c, dryRun) {
  const url = row.url;
  if (!canQuote(url, s, c)) return { ok: false, skipped: true };

  await log('引用一条：' + (row.author ? '@' + row.author + ' ' : '') + (row.why || ''));

  const g = await makeQuote(row, c);
  if (!g.ok) {
    if (g.err) { await log('  写不出来：' + g.err); return { ok: false }; }
    /* 两次都不合格：这条不引了。宁可不发，也不发一条 AI 味的永久帖。 */
    await log('  两次都没过闸（' + g.bad + '），这条不引了');
    return { ok: false, rejected: true, text: g.text || '' };
  }
  if (g.attempt > 1) await log('  第一版没过闸，重写了一次');

  row.quoteText = g.text;

  /* 打字和发前检查的时间交给页面算（跟回帖同一套）。 */
  const tm = humanTiming(row.tlen || row.text, g.text);
  const tmo = 200000 + tm.type * 1000;

  try {
    const r = await dispatch({
      type: 'quote', url, text: g.text, send: !dryRun,
      typeMs: tm.type * 1000, checkMs: tm.check * 1000,
    }, tmo);

    const d = r || {};
    /* 已经转过的话页面报的是 already，不是失败 —— 引用的入口就是转推按钮，
     * 按钮已经是「已转」状态就进不去那个菜单了。不占今天的引用名额。 */
    if (d.already) { await log('  这条本来就是转过状态，不引了'); return { ok: false, already: true }; }
    if (!d.sent) return { ok: true, dry: true };     // 试运行：只填不发

    await markQuoted(url, s, row.handle, g.text);
    await saveSt(s);
    return { ok: true, text: g.text };
  } catch (e) {
    await log('  引用没成：' + e.message);
    return { ok: false };
  }
}

/* ── 本地硬门槛：这条值不值得转 ──
 * 转推也是「替别人背书」，比回帖重：
 * 回帖说错了是你自己的观点，转推说错了是「我推荐你们看这个」。
 * 所以这里宁可错杀 —— 反正一天最多一两个，漏掉几个无所谓。
 */
function repostWorthy(it, c) {
  /* 转推 / 回复带出来的不是原创（via 有值）。转别人的转推，
   * 链条一长谁都看不懂在说什么，而且原帖可能根本不是这个人的观点。 */
  if (it.via) return false;

  const t = String(it.text || '').trim();
  if (t.length < 20) return false;                 // 太短，多半是段子、情绪或一句口号
  if (/^https?:\/\//.test(t)) return false;        // 纯链接，点进去是什么都不知道
  if (/(空投|抽奖|白名单|进群|加V|返佣|注册就送)/i.test(t)) return false;

  /* 没人看的东西转了也没意义 —— 0 回复 0 赞通常意味着要么刚发出来、
   * 要么就是没人关心。转推的价值在于「让更多人看见」，前提是本来就值得看。 */
  const r = +it.replies || 0;
  const k = +it.likes || 0;
  if (r < 1 && k < 5) return false;
  return true;
}

/* 这条现在还能不能转：开关开着、今天抽到的配额还没用完、以前没转过。
 * 以前没转过这一条最重要 —— 再点一次「转推」其实是「取消转推」，
 * 那比不转还糟：粉丝刚看到你转，转头就没了。 */
function canRepost(url, s, c) {
  if (!c.autoRepost) return false;
  if (!url) return false;
  /* repostTarget 是今天现抽的配额（可能是 0）。没抽过（-1）按 0 算 ——
   * 宁可不转，也别在配额不明的时候放它出去。 */
  const quota = s.repostTarget == null ? 0 : +s.repostTarget;
  if ((s.repostToday || 0) >= quota) return false;
  if ((s.repostLog || []).some((x) => x.u === url)) return false;
  return true;
}

/* 记一笔转推。只记 url + 作者 + 时间，够用来去重，也够面板显示。 */
async function markReposted(url, s, handle, why) {
  s.repostToday = (s.repostToday || 0) + 1;
  if (!Array.isArray(s.repostLog)) s.repostLog = [];
  s.repostLog.push({
    u: url, h: String(handle || '').replace(/^@/, ''),
    at: Date.now(), why: String(why || '').slice(0, 40),
  });
  if (s.repostLog.length > 400) s.repostLog = s.repostLog.slice(-400);
  await saveSt(s);
}

/* 转推一条。这条不回帖 —— 转推正好填「没话说但内容值得让粉丝看见」这个空档。
 * 转完如果这个作者也够格，顺手关注：页面那边会按「先转、再关注」的顺序做。 */
async function doRepostTask(row, s, c) {
  const url = row.url;
  if (!canRepost(url, s, c)) return { ok: false, skipped: true };

  const fh = (row.follow > 0 && row.handle && canFollow(row.handle, s, c)) ? row.handle : '';
  await log('转推一条：' + (row.author ? '@' + row.author + ' ' : '') + (row.why || ''));

  let r = null;
  try {
    r = await dispatch({ type: 'repost', url, followHandle: fh }, 150000);
  } catch (e) {
    await log('  转推没成：' + e.message);
    return { ok: false };
  }

  const d = r || {};
  /* 已经是转过的状态：可能是作者自己手动转过，也可能是之前那次没记上。
   * 不占今天的名额（不 markReposted），但也不再试这条。 */
  if (d.already) { await log('  这条本来就是转过状态'); return { ok: false, already: true }; }
  if (!d.ok) { await log('  转推没成：' + (d.why || '页面没给结果')); return { ok: false }; }

  await markReposted(url, s, row.handle, row.why);
  await log('  转出去了（今日第 ' + (s.repostToday || 0) + ' 个）');

  /* 关注结果单独看，转推已经成了，不能被关注失败连累。 */
  if (fh) {
    const fr = d.follow || null;
    if (fr && fr.ok && !fr.already) {
      await markFollowed(fh, s, row.why || '转推时顺手关注');
      await log('  顺手关注了 @' + fh + '（今日第 ' + (s.followToday || 0) + ' 个）' +
                (fr.requested ? '，对方是受保护账号，只发了请求' : ''));
    } else if (fr && fr.already) {
      await log('  @' + fh + ' 本来就是关注状态');
    } else {
      await log('  关注 @' + fh + ' 没成：' + ((fr && fr.why) || '页面没给结果'));
      await markFollowFailed(fh, s);
    }
  }
  return { ok: true };
}

/* X 的字数权重：中文算 2，其他算 1 */
function xlen(s) {
  let n = 0;
  for (const ch of String(s || '')) {
    const c = ch.codePointAt(0);
    if (c === 10) { n += 1; continue; }
    if ((c >= 0x1100 && c <= 0x115F) || (c >= 0x2E80 && c <= 0xA4CF) || (c >= 0xAC00 && c <= 0xD7A3) ||
        (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFE30 && c <= 0xFE6F) || (c >= 0xFF00 && c <= 0xFF60) ||
        (c >= 0xFFE0 && c <= 0xFFE6)) n += 2;
    else n += 1;
  }
  return n;
}

function dayKeyNow() { return new Date().toISOString().slice(0, 10); }

/* ── 一条回复该花多久 ──
 * 作者发现的问题：09:01:53 看到帖子，09:02:05 就回完了，12 秒。
 * 真人不可能 —— 光是打完那 32 个字就要 40 秒。
 *
 * 原来那 12 秒全是「模型生成 + 三次点击」，中间没有一秒钟花在读和想上。
 * 所以按内容量重新算一遍，四个阶段各自有依据：
 *   读  中文约 10 字/秒（含理解的停顿），最少 5 秒
 *   想  10~40 秒，看这条有没有值得接的点
 *   打  55 字/分钟 ×1.3（删改、停顿、改主意）
 *   查  3~10 秒，发之前扫一眼有没有错字
 * 一条 32 字的回复配 60 字的帖子，算下来 70~110 秒，中位 87 秒。
 */
function humanTiming(post, replyText) {
  /* post 可以传字符串，也可以直接传原始字数。
   * 一定要传原始长度 —— batch 里存的正文截断到 90 字（面板显示用），
   * 拿它算读帖时间会把长帖算成短帖。 */
  const postLen = typeof post === 'number' ? post : String(post || '').length;
  const replyLen = String(replyText || '').length;

  const read = Math.min(90, 5 + postLen / 10);
  const think = 10 + Math.random() * 30;
  const type = Math.max(6, replyLen / 55 * 60 * 1.3);
  const check = 3 + Math.random() * 7;

  return {
    read: Math.round(read),
    think: Math.round(think),
    type: Math.round(type),
    check: Math.round(check),
    total: Math.round(read + think + type + check),
  };
}

/* 今天这一项配额抽几个：0 ~ max 均匀抽，整数。
 * 抽到 0 就是「今天一个都不转 / 不引」，这是有意的 ——
 * 固定配额会让「每天正好 2 个」变成规律，随机才有「今天不想动」的人味。 */
function drawQuota(max) {
  const m = Math.max(0, Math.round(+max || 0));
  return Math.floor(Math.random() * (m + 1));
}

async function rollDay() {
  const s = await st();
  const c = await cfg();
  const k = dayKeyNow();
  if (s.dayKey !== k) { s.dayKey = k; s.sentToday = 0; await saveSt(s); }
  /* 关注的日限额单独翻页。followLog 不清 —— 那是「关注过谁」的底账，
   * 用来去重，也用来算哪个号跟了一周还没动静。 */
  if (s.followDayKey !== k) { s.followDayKey = k; s.followToday = 0; await saveSt(s); }
  /* 转推、引用：每天现抽一个 0~上限 的配额。底账同样留着 ——
   * 那是「哪条动过了」的凭据，清掉的话同一条可能被转第二次 / 引第二次。 */
  if (s.repostDayKey !== k) {
    s.repostDayKey = k; s.repostToday = 0;
    s.repostTarget = drawQuota(c.repostDaily);
    await saveSt(s);
  }
  if (s.quoteDayKey !== k) {
    s.quoteDayKey = k; s.quoteToday = 0;
    s.quoteTarget = drawQuota(c.quoteDaily);
    await saveSt(s);
  }
}

/* ────────────── 模型 ────────────── */

async function callModel(prompt, opt) {
  opt = opt || {};
  const c = await cfg();
  if (!c.key) throw new Error('还没填 API Key。点右上角「设置」粘一个进来就行（接口地址已经默认是 DeepSeek）。');
  const base = String(c.base).replace(/\/+$/, '');
  let r;
  try {
    r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key },
      body: JSON.stringify({
        model: c.model || 'deepseek-chat',
        messages: [
          { role: 'system', content: opt.system || c.persona || DEF_PERSONA },
          { role: 'user', content: prompt },
        ],
        temperature: opt.temperature != null ? opt.temperature : 1.05,
        max_tokens: opt.maxTokens || 1400,
      }),
    });
  } catch (e) {
    throw new Error('连不上模型接口（' + base + '）。检查地址填对没、网络通不通、扩展有没有这个域名的权限。');
  }
  if (!r.ok) throw new Error('模型返回 ' + r.status + '：' + (await r.text()).slice(0, 180));
  const j = await r.json();
  const ctn = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!ctn) throw new Error('模型没有返回内容');
  return ctn;
}

function parseBlocks(raw) {
  const clean = (s) => s.trim()
    .replace(/^(?:\d+[.、)）]|[-*•]|[①②③④⑤⑥⑦⑧⑨⑩])\s*/, '')
    .replace(/^["“「『']([\s\S]*)["”」』']$/, '$1')
    .trim();

  let list = raw.split(/\n\s*#{3,}\s*\n|\n\s*-{3,}\s*\n|\n\s*={3,}\s*\n/)
    .map(clean).filter((s) => s.length > 1);

  if (list.length <= 1) {
    let parts = raw.split(/\n\s*(?=\d{1,2}[.、)）])|\n\s*(?=[①②③④⑤⑥⑦⑧⑨⑩])/);
    if (parts.length <= 1) parts = raw.split(/\n\s*\n/);
    const alt = parts.map(clean).filter((s) => s.length > 1);
    if (alt.length > list.length) list = alt;
  }
  return list;
}

/* 回复写法轮换：长短、角度都不一样，避免十条一个模子 */
const STYLES = [
  '一句话说完，20 字以内，像随口接一句',
  '两句话，30~50 字，先接住他一个点，再补一句自己的',
  '用一句反问把话递回去，别给结论',
  '只丢一个数字或一个事实，不评论',
  '自嘲一句，把自己也放进坑里',
  '点出他没说出口的那个前提，一句话就够',
  '带点情绪的吐槽，口语，别用力过猛',
  '短句加留白，不超过 25 字',
];

/* 回复长度也分档：真人的短评多数就是一句话，七八个字完了。
 * 每条都写三四行才不像人。 */
const LEN_TIERS = [
  { p: 0.70, a: 10, b: 25, text: '很短，10~25 字，一句话说完' },
  { p: 0.20, a: 25, b: 45, text: '中等，25~45 字，最多两句' },
  { p: 0.10, a: 45, b: 70, text: '稍长，45~70 字，但别写成小作文' },
];

function pickLen() {
  const r = Math.random();
  let acc = 0;
  for (const t of LEN_TIERS) {
    acc += t.p;
    if (r < acc) return t;
  }
  return LEN_TIERS[0];
}

function buildPrompt(text, type, stance, n, style, len, angle) {
  return `原帖：
"""
${text}
"""

帖子类型：${type === '自动判断' ? '你自己判断' : type}
回复姿态：${stance === '自动' ? '你自己挑最合适的' : stance}
${style ? '这次的写法：' + style : ''}
${len ? '长度：' + len.text : ''}
${angle ? '从这个角度接：' + angle : ''}
写 ${n} 条。

输出要求：只输出回复正文，每条之间用一行 ### 分隔。不要编号、不要标题、不要解释、不要加引号。`;
}

/* ────────────── 跟页面通信 ────────────── */

let extVer = '';
const pending = new Map();
const lateWatch = new Set();
let seq = 0;
/* 上一次 ping 成功的时间。第二轮起每轮都会硬刷新页面，
 * 刷新那几秒 content script 还没注入，ping 必然失败 —— 面板就会闪一下「未打开」。
 * 记个时间，几秒内失败就当还是好的。 */
let lastPingOkAt = 0;

async function findXTab() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  } catch (e) { return null; }
  if (!tabs.length) return null;

  // 优先挑能响应 ping 的（说明 content script 已经注入）
  for (const t of tabs) {
    try {
      const r = await chrome.tabs.sendMessage(t.id, { type: 'ping' });
      if (r && r.ok) { extVer = r.ver || extVer; lastPingOkAt = Date.now(); return t; }
    } catch (e) { /* 这个标签还没注入，试下一个 */ }
  }
  return null;
}

/* 面板每 1.5 秒问一次状态，每次都去 ping 一遍 x.com 标签太浪费。
 * 缓存 4 秒，比 pageOk 那个 6 秒宽限还短，显示不会滞后。 */
let tabCacheAt = 0;
let tabCacheVal = null;
async function findXTabCached() {
  if (Date.now() - tabCacheAt < 4000) return tabCacheVal;
  tabCacheVal = await findXTab().catch(() => null);
  tabCacheAt = Date.now();
  return tabCacheVal;
}

/* 结果回收：正常回来的、以及页面跳转后接力回来的，都走这里 */
function settle(body) {
  if (body.ver) extVer = body.ver;
  const p = pending.get(body.id);
  if (!p) {
    /* 迟到结果：这条之前已经被当成失败结算掉了（比如 worker 被浏览器杀了），
     * 但页面上其实做完了。清掉 inflight 免得引擎空等，真发出去了还要记进 sentUrls，
     * 否则下一轮会对同一条重复回复。
     * 只有回帖算「今日已发」—— 引用是另一本账（quoteToday），
     * 记到 sentToday 上会让回帖额度虚减，还会把这条 url 塞进 sentUrls 挡住以后的回复。 */
    clearInflight(body.url);
    if (body.url && body.data && body.data.sent && body.taskType !== 'quote') recordLateSent(body.url);
    return;
  }
  clearTimeout(p.timer);
  pending.delete(body.id);
  if (body.error) p.reject(new Error(body.error));
  else p.resolve(body.data);
}

async function clearInflight(url) {
  const l = await lp();
  if (l.inflight && (!url || l.inflight.url === url)) {
    l.inflight = null;
    await saveLp(l);
  }
}

async function recordLateSent(url) {
  const s = await st();
  if (s.sentUrls.includes(url)) return;
  s.sentUrls.push(url);
  s.sentToday++;
  await saveSt(s);
  await log('（迟到的结果）这条其实已经回上了：' + String(url).slice(-12));
}

async function dispatch(task, timeoutMs = 45000) {
  const tab = await findXTab();
  if (!tab) throw new Error('没找到打开的 x.com 标签页。先打开一个 x.com 页面，再回来。');

  const id = 't' + Date.now().toString(36) + (++seq);

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('页面没响应（超时）。检查一下 x.com 标签页还在不在、有没有卡住'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
  });

  chrome.tabs.sendMessage(tab.id, { type: 'run', task: Object.assign({ id }, task) })
    .then((resp) => {
      if (!resp) return; // 通道被刷新打断，等接力结果
      /* taskType 单独传：settle 要按它区分「这条算回帖还是引用」。
       * 不能叫 type —— taskResult 那条中继消息自己占着 type 字段。 */
      if (resp.ok) settle({ id, data: resp.data, ver: resp.ver, url: task.url, taskType: task.type });
      else settle({ id, error: resp.error || '页面没返回结果', url: task.url, taskType: task.type });
    })
    .catch((e) => {
      const m = (e && e.message) || String(e);
      if (/back\/forward|bfcache|message port|message channel|Receiving end does not exist|Could not establish connection|Extension context invalidated/i.test(m)) {
        /* 页面整跳 / 进缓存，任务会在新页面上接着做完（content.js 的 resume）。
         * 先别判失败，等 60 秒；这期间接力把结果送回来就作废。 */
        lateWatch.add(id);
        setTimeout(() => {
          if (lateWatch.delete(id)) settle({ id, error: '页面跳转后没能接着做。刷新一下 x.com 再试。', url: task.url });
        }, 60000);
      } else {
        settle({ id, error: m, url: task.url });
      }
    });

  return done;
}

/* ────────────── 循环引擎 ────────────── */

async function log(s) {
  const l = await lp();
  const t = new Date().toTimeString().slice(0, 8);
  l.log.push(t + '  ' + s);
  if (l.log.length > 120) l.log.shift();
  await saveLp(l);
}

let pumping = false;

/* 每一步都由心跳来推：到点了就往前走一格，没到点就什么都不做 */
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    const l = await lp();
    if (!l.running) return;

    /* worker 被杀之前派出去的那条，回来没回来都不知道。
     * 超过它自己的超时就当它不会有结果了 —— 但**不能重发**：
     * 页面很可能已经把字填了、按钮点了，只是结果没送回来。
     * 重发就是在同一条推文下面留两条回复（引用更糟：主页上两条一样的），
     * 比漏掉一条难看多了。所以标成「不确定」直接迈过去。
     *
     * 过期时间按任务自己报的 tmo 算，不能写死：回帖一两分钟，
     * 引用可能要六七分钟。用固定值的话，长任务会被误判成「没回音」，
     * 然后 idx 被推一次、真结果回来又推一次，中间那条就静默跳过了。 */
    if (l.inflight) {
      const stale = Math.max(130000, (+l.inflight.tmo || 0) + 30000);
      if (Date.now() - l.inflight.at < stale) return; // 还在做，别插队
      const u = l.inflight.url;
      const kind = l.inflight.kind || 'reply';
      l.inflight = null;
      const row = l.batch && l.batch[l.idx];
      if (row && row.url === u && /^(待发|引用中|只转推)$/.test(row.state)) {
        row.state = '不确定';
        l.idx++;
      }
      await saveLp(l);
      await log('这条' + (kind === 'quote' ? '引用' : kind === 'repost' ? '转推' : '') +
                '等太久没回音，可能已经发出去了，跳过不重发');
    }

    if (l.nextAt && Date.now() < l.nextAt) return; // 还在等间隔 / 休息

    if (l.phase === 'wait') { l.phase = 'reply'; l.nextAt = 0; await saveLp(l); }
    else if (l.phase === 'window') {
      /* 睡到下一个时间段了。先抓一批 —— 隔了这么久，时间线早换了 */
      l.phase = 'fetch'; l.nextAt = 0;
      l.sessionTarget = 0; l.sessionDone = 0; l.emptyRounds = 0;
      await saveLp(l);
      await log('到时间段了，接着跑');
    }
    else if (l.phase === 'away') {
      /* 走开结束了，回来重新坐下。先抓一批 —— 隔了这么久，时间线早换了 */
      l.phase = 'fetch'; l.nextAt = 0;
      l.sessionTarget = 0; l.sessionDone = 0; l.emptyRounds = 0;
      await saveLp(l);
      await log('回来了，接着往下看');
    }

    if (l.phase === 'fetch') return await stepFetch();
    if (l.phase === 'reply') return await stepReply();
    if (l.phase === 'idle') { l.phase = 'fetch'; await saveLp(l); return await stepFetch(); }
  } catch (e) {
    await log('出错了：' + ((e && e.message) || e));
  } finally {
    pumping = false;
  }
}

async function stepFetch() {
  const c = await cfg();
  const s = await st();
  const l = await lp();

  /* 会话开头：抽这一趟打算回几条。中途再抓的批次不会重新抽 */
  if (!l.sessionTarget) {
    l.sessionTarget = pickSessionCount(c);
    l.sessionDone = 0;
    l.sessionStartAt = Date.now();
    l.emptyRounds = 0;
  }

  l.round++;
  l.phase = 'fetch';
  await saveLp(l);
  await log('第 ' + l.round + ' 轮' + (l.round > 1 ? '，接着往下翻' : '，抓取') +
    '…（这段还差 ' + Math.max(0, l.sessionTarget - l.sessionDone) + ' 条）');

  let items;
  try {
    items = await dispatch({
      type: 'fetch',
      limit: l.limit,
      tab: c.tabLabel,
      /* 传完整的 seen。以前只传最后 1200 条，可存储里留了 3000 ——
       * 前 1800 条页面以为没抓过，白翻十几屏抓回来一堆旧的，
       * 过滤完一条新的不剩，看着就是「卡住不动」。 */
      seen: s.seenUrls,
      /* 不再整页刷新：先往下翻着找，翻不到才软刷新一次（点一下 tab，不 reload）。
       * 一个真人不会每隔几分钟把时间线整个刷一遍。 */
      refresh: l.round > 1,
      hard: false,
      /* 滚动节奏放慢到接近真人之后，一轮抓取要 60~80 秒，超时得跟着放宽 */
    }, 120000);
  } catch (e) {
    if (CACHE.lp !== l) return;   // 抓的时候点了停止，别写回去
    l.retryFetch = (l.retryFetch || 0) + 1;

    /* 标签页被关掉 / 被浏览器冻结时，抓取会一直失败。
     * 以前固定等 15 秒重试，日志几分钟就被刷干净，而且永远不停。
     * 改成翻倍退避，连续 5 次就自己停下来。 */
    if (l.retryFetch > 5) {
      l.running = false; l.phase = 'idle'; l.nextAt = 0;
      await saveLp(l);
      await log('连续 ' + l.retryFetch + ' 次抓不到，先停了。' + e.message);
      await log('检查一下 x.com 那个标签页还在不在、有没有卡住，然后点开始。');
      return;
    }
    const wait = Math.min(300, 15 * Math.pow(2, l.retryFetch - 1));
    /* 这一轮没抓成，轮次退回去 —— 不然重试几次之后日志里「第 7 轮」
     * 但一条都没回过，看着像跑了很多轮 */
    l.round = Math.max(0, l.round - 1);
    await log('抓取失败（第 ' + l.retryFetch + ' 次）：' + e.message + '，' + fmtSec(wait) + '后重试');
    l.phase = 'fetch';
    l.nextAt = Date.now() + wait * 1000;
    await saveLp(l);
    return;
  }

  /* 抓取要几十秒，这期间可能点了停止、也可能停了又重开 —— 都不能再往下写，
   * 否则旧任务会把新循环的 batch/round 盖掉。 */
  if (CACHE.lp !== l) return;
  if (!l.running) return;

  const freshAll = (items || []).filter(
    (x) => !s.seenUrls.includes(x.url) && !l.seenThisRun.includes(x.url) && !s.sentUrls.includes(x.url),
  );
  l.retryFetch = 0;   // 抓到了，退避计数归零
  await log('拿到 ' + (items || []).length + ' 条，新的 ' + freshAll.length + ' 条');

  // 抓过的全部记账，下一轮不会再抓（被跳过的也算抓过，不会回头再回）
  for (const it of items || []) {
    if (!s.seenUrls.includes(it.url)) s.seenUrls.push(it.url);
  }
  if (s.seenUrls.length > 3000) s.seenUrls = s.seenUrls.slice(-3000);
  await saveSt(s);

  if (!freshAll.length) {
    /* 连着几次翻不到新帖，多半不是「这批刚好都看过」。
     * 要么真滚到底了，要么页面根本没渲染出新内容 —— 后者最常见的原因就是
     * x.com 那个标签页被切到后台（Chrome 会停掉隐藏页面的渲染）。
     *
     * 以前这里固定等 60 秒再试，没有尽头：后台跑一整夜会攒下几百行同样的日志，
     * 把前面真正有用的记录冲干净，而且永远不告诉人发生了什么。 */
    l.emptyFetches = (l.emptyFetches || 0) + 1;
    if (l.emptyFetches >= 5) {
      l.running = false; l.phase = 'idle'; l.nextAt = 0;
      await saveLp(l);
      await log('连着 ' + l.emptyFetches + ' 次翻不到新帖，先停了。');
      await log('多半是 x.com 那个标签页被切到后台，浏览器不再往下渲染。切回前台点开始。');
      return;
    }
    const wait = Math.min(600, 60 * Math.pow(2, l.emptyFetches - 1));
    await log('这批没有新的了（第 ' + l.emptyFetches + ' 次），' + fmtSec(wait) + '后再试');
    l.phase = 'fetch';
    l.nextAt = Date.now() + wait * 1000;
    await saveLp(l);
    return;
  }
  l.emptyFetches = 0;   // 翻到新东西了，这个计数归零

  /* 一批不一定要全回。全回太整齐 —— 十连回比隔三差五回一条更像机器。
   *   rand3  挑几条回（screen 开着就先让模型挑有话可接的），其余标「跳过」
   *   all    全回
   *   skip   一条都不回，直接刷新下一批
   * 跳过的也留在 batch 里，面板上能看见「这条我没回」，不然会以为漏了。 */

  // 规则先筛：抽奖、广告、太短、纯链接的不用问模型
  const usable = freshAll.filter((x) => !looksBad(x.text));
  const dropped = freshAll.length - usable.length;
  if (dropped > 0) await log('先筛掉 ' + dropped + ' 条（广告/抽奖/太短），剩 ' + usable.length + ' 条能看');

  const picked = new Set();
  const meta = {};        // url -> {why, angle}
  const followMeta = {};  // url -> {f, handle}  跟 picked 无关，各算各的
  const repostMeta = {};  // url -> {r}          同样独立，跟上面两个都无关
  const quoteMeta = {};   // url -> {r}          跟 repostMeta 互斥（r=3 引、r=2 转）
  /* 模型到底有没有给出答复。这个区分很关键：
   *   报错（网络 / 格式）  → 退回随机挑，别让这一轮卡死
   *   成功但返回空数组     → 它是真的说"这批没一条值得回"，那就别硬凑 */
  let screened = false;
  const maxPick = pickCount(c.pickMin, c.pickMax, usable.length);

  if (!usable.length) {
    /* 一批全被规则筛掉了 */
    await log('这批没一条能接的，直接翻过去');
  } else if (c.screen && usable.length > 1) {
    /* 先让模型看一眼：哪几条有话可接、哪些人值得跟 */
    try {
      const sel = await screenPosts(usable, c);
      if (CACHE.lp !== l) return;
      screened = true;

      const byUrl = new Map(usable.map((x) => [x.url, x]));
      let nFollow = 0;
      let nRepost = 0;
      let nQuote = 0;

      for (const s2 of sel) {
        const src = byUrl.get(s2.url);
        if (!src) continue;

        /* 判断一：值不值得回。
         * 给了 why 就是明确想回；只给 f 或只给 r 不给 why，说明它是
         * 「这人值得跟 / 这条值得转，但这条没话说」，那就不回。
         * 三样都没给（老格式或模型偷懒）按老规矩算挑中，
         * 免得一次格式退化就整批不回。 */
        const wantsReply = !!s2.why || !(s2.f > 0 || s2.r > 0);
        if (wantsReply && picked.size < maxPick) {
          picked.add(s2.url);
          if (s2.why) meta[s2.url] = { why: s2.why, angle: s2.angle };
        }

        /* 判断二：这个作者值不值得关注。跟上面那个 if 没有任何关系 ——
         * 一条帖子可以不回但人想跟，也可以回得挺好但人是广告号。 */
        if (c.autoFollow && s2.f >= c.followMinScore && followWorthy(src, c)) {
          followMeta[s2.url] = { f: s2.f, handle: src.handle };
          nFollow++;
        }

        /* 判断三：这条内容要不要动它。r=3 引用、r=2 转推，二选一。
         * 三道闸叠着来 ——
         * ① 模型给到 3 分（引用）或 2 分（转推）
         * ② 本地硬门槛
         * ③ 今天抽到的配额（0~上限，抽到 0 就是那天不动）
         *
         * 已经挑来回的就不动了 —— 又回又转/又回又引同一条太用力，回复本身就够。
         *
         * 转推那行是 r >= 2 而不是 r === 2：模型给了 3 分、但引用这条路走不通
         * （开关关了 / 太短 / 回复太多）的时候，它还能退成转推。
         * 写成 === 2 的话，一条 25 个字的帖子拿 3 分就**什么都不做**，
         * 静默丢掉 —— 明明转推的门槛比引用低，它够格。 */
        if (!picked.has(s2.url) && s2.r >= 3 && c.autoQuote && quoteWorthy(src, c)) {
          quoteMeta[s2.url] = { r: s2.r };
          nQuote++;
        } else if (!picked.has(s2.url) && s2.r >= 2 && c.autoRepost && repostWorthy(src, c)) {
          repostMeta[s2.url] = { r: s2.r };
          nRepost++;
        }
      }

      if (picked.size) {
        await log('模型挑了 ' + picked.size + ' 条回，其余 ' + (freshAll.length - picked.size) + ' 条跳过');
        for (const u of picked) if (meta[u] && meta[u].why) await log('  · ' + meta[u].why);
      } else {
        await log('模型说这批没一条值得回');
      }
      if (nFollow) await log('另外有 ' + nFollow + ' 个作者够格，翻到的时候顺手关注');
      if (nRepost) await log('还有 ' + nRepost + ' 条够格转，翻到的时候转出去');
      if (nQuote) await log('有 ' + nQuote + ' 条够格引用，翻到的时候加一句发出去');
    } catch (e) {
      await log('挑帖没成（' + e.message + '），这轮随便挑几条');
    }
  }

  /* 只有「没拿到模型的答复」时才退回随机。
   * 模型明确说都不值得回的话，宁可这批空着翻下一批 ——
   * 没话说还硬写一句，只会吐出套话，那比少回几条更像机器。 */
  if (!screened && !picked.size && usable.length) {
    const n = pickCount(c.pickMin, c.pickMax, usable.length);
    shuffle(usable).slice(0, n).forEach((x) => picked.add(x.url));
    await log('这批挑 ' + n + ' 条回，其余 ' + (freshAll.length - n) + ' 条跳过');
  }

  /* 被规则筛掉的那些，卡片上也写一句为什么 —— 不然只显示「跳过」，
   * 看着像随机漏了，其实是有意的 */
  const usableSet = new Set(usable.map((x) => x.url));
  const hasFollow = Object.keys(followMeta).length > 0;
  const hasRepost = Object.keys(repostMeta).length > 0;
  const hasQuote = Object.keys(quoteMeta).length > 0;

  /* 关注、转推、引用也算产出。一批里一条都没回、但跟了个人或动了一条，
   * 不算「空转」，否则连着几批只关注就会误判成「没东西可看」提前走开。 */
  if (picked.size || hasFollow || hasRepost || hasQuote) l.emptyRounds = 0;

  l.batch = freshAll.map((it) => ({
    url: it.url,
    author: it.author || '',
    handle: it.handle || '',
    text: String(it.text || '').replace(/\s+/g, ' ').slice(0, 90),
    /* 原始字数。正文上面截断到 90 字给面板显示用，
     * 但读帖时间要按真实长度算，不然长帖会被当成短帖。 */
    tlen: String(it.text || '').length,
    reply: '',
    why: (meta[it.url] && meta[it.url].why) ||
         (usableSet.has(it.url) ? '' : '像广告 / 抽奖 / 太短，规则筛掉了'),
    angle: (meta[it.url] && meta[it.url].angle) || '',
    /* follow / repost / quote 都是这一条自己的属性，跟 state 无关：
     * state=跳过 也可能 follow>0（不回，但这个人想跟）、
     * 也可能 repost>0（不回，但这条内容值得转）、
     * 也可能 quote>0（不回，但这条值得加一句话引出去）。 */
    follow: followMeta[it.url] ? followMeta[it.url].f : 0,
    repost: repostMeta[it.url] ? repostMeta[it.url].r : 0,
    quote: quoteMeta[it.url] ? quoteMeta[it.url].r : 0,
    state: picked.has(it.url) ? '待发' : '跳过',
  }));
  l.idx = 0;

  if (!picked.size && !hasFollow && !hasRepost && !hasQuote) {
    l.emptyRounds = (l.emptyRounds || 0) + 1;

    /* 连着三批一条想回的都没有 —— 真人也会起身走开，不会死磕一屏 */
    if (l.emptyRounds >= 3) {
      const n = l.emptyRounds;
      const sessMin = Math.max(1, Math.round((Date.now() - (l.sessionStartAt || Date.now())) / 60000));
      const away = pickAwayMin(c, sessMin);
      l.phase = 'away';
      l.nextAt = Date.now() + away * 60000;
      l.sessionTarget = 0; l.sessionDone = 0; l.emptyRounds = 0;
      await saveLp(l);
      await log('连着 ' + n + ' 批没一条想回的，走开 ' + fmtSec(away * 60));
      return;
    }

    /* 一条都不回：隔久一点再翻。翻太快既像机器，也白费带宽 ——
     * 真人翻时间线也是看一会儿才往下走。 */
    const wait = pickGap(30, 90);
    await log('这次不回，' + wait + ' 秒后接着翻');
    l.phase = 'fetch';
    l.nextAt = Date.now() + wait * 1000;
    await saveLp(l);
    return;
  }

  /* 日志里报「第一条」得报真在处理的那条：先找挑中的，没有就找要转的。
   * 一批只转不回的场合，报 freshAll[0] 会让人以为在回一条根本没选中的帖子。 */
  const lead = freshAll.find((x) => picked.has(x.url)) ||
               freshAll.find((x) => quoteMeta[x.url] || repostMeta[x.url]) ||
               freshAll[0];
  await log('第一条：' + String((lead && lead.text) || '').replace(/\s+/g, ' ').slice(0, 40));

  l.phase = 'reply';
  l.nextAt = 0;
  await saveLp(l);
}

async function stepReply() {
  const c = await cfg();
  let l = await lp();
  const s = await st();

  /* 处理一条要好几十秒，中途用户可能点了停止（running=false），
   * 也可能停了又立刻开始（CACHE.lp 换成新对象）。
   * 这两种情况下这个函数都得立刻收手，否则会把新循环的状态覆盖掉。 */
  const current = () => CACHE.lp === l;        // 还是同一个循环
  const alive = () => l.running && current();  // 还在跑，而且是当前这个

  /* 这批里没被挑中的（state='跳过'）直接迈过去，别为它们调模型。
   * 但 follow>0 / repost>0 / quote>0 的不能迈 —— 那条帖子不回，
   * 人还是想跟、或者内容还是值得动一下。 */
  while (l.idx < l.batch.length && l.batch[l.idx] &&
         l.batch[l.idx].state === '跳过' &&
         !(l.batch[l.idx].follow > 0) && !(l.batch[l.idx].repost > 0) &&
         !(l.batch[l.idx].quote > 0)) l.idx++;

  if (l.idx >= l.batch.length) {
    l.phase = 'fetch';
    l.nextAt = 0;
    await saveLp(l);
    return;
  }

  await rollDay();

  const row = l.batch[l.idx];
  if (!row || !row.url) { l.idx++; l.phase = 'reply'; await saveLp(l); return; }

  /* 到今日上限就真停。放在下面三个动作前面 —— 以前排在它们后面，
   * 意味着「到上限了还会再引一条」，跟「停了」自相矛盾。 */
  if (s.sentToday >= c.dailyMax) {
    await log('到今日上限 ' + c.dailyMax + ' 条，停了');
    l.running = false; l.phase = 'idle'; l.nextAt = 0;
    await saveLp(l);
    return;
  }

  /* 只在设定的时间段里发。窗口外就睡到下一个窗口开始 ——
   * 机器能 24 小时不停，人不能。
   * 单独用 window 这个 phase（不是 wait），面板才能说清「等下一个时间段」，
   * 而不是显示成「等下一条 3 小时」让人以为卡住了。
   *
   * 这一步必须排在引用 / 转推 / 关注前面：那三个也是「往外面发东西」，
   * 引用尤其 —— 它是永久帖，半夜三点挂一条出来比回帖显眼得多。 */
  const wins = parseWindows(c.windows);
  if (wins.length && !inWindows(wins, new Date())) {
    const ms = Math.max(60000, msToWindow(wins, new Date()));
    l.phase = 'window';
    l.nextAt = Date.now() + ms;
    await saveLp(l);
    await log('不在时间段内，' + fmtSec(ms / 1000) + ' 后（下一个时间段）再继续');
    return;
  }

  /* 这条不回、但你有实质的东西可以加：引用发一条。
   * 放在转推前面 —— 引用是「表态」，转推是「让粉丝自己看」，
   * 同一份内容只能选一个，而模型给的 r 分已经把这件事判过了（3 引、2 转）。 */
  if (row.state === '跳过' && row.quote > 0) {
    row.state = '引用中';
    /* 引用可能要六七分钟（读 + 打字 + 检查）。这个 inflight 是给
     * 「worker 被杀之后」用的：重启后先看它，别把一条刚引过的帖子
     * 当成待回、再回一条上去。tmo 只是上限，宁可等久一点也别重复动手。 */
    l.inflight = { url: row.url, at: Date.now(), kind: 'quote', tmo: 420000 };
    await saveLp(l);

    const res = (await doQuoteTask(row, s, c, l.dryRun)) || {};
    if (!current()) return;   // 写字的这几分钟里点了停止又重开，不是这个循环的事了

    row.state = res.ok ? (res.dry ? '已填引用' : '已引用')
      : res.skipped ? '跳过'
      : res.rejected ? '没写出人话'
      : res.already ? '已转过'
      : '引用失败';
    if (res.rejected) row.quoteBad = res.text || '';
    l.inflight = null;

    /* 停止是在这条引用途中点的：字已经填好、按钮也点了，撤不回来。
     * 那就把结果记下来，但不再等间隔、不再进下一条。
     * 这里必须单独判 alive() —— 只判 current() 的话，停了之后还会把
     * phase 写成 reply、nextAt 写成未来的时间，面板上就成了「停了但还在倒计时」。 */
    if (!alive()) {
      await saveLp(l);
      await log((res.ok && !res.dry ? '这条引用发完了' : '引用没成') + '，已停止');
      return;
    }

    l.idx++;
    if (res.ok) {
      /* 引用是一条真帖，发完停久一点再动下一条 —— 连着两条引用比连着回帖显眼得多。 */
      const gap = pickGap(40, 120);
      l.phase = 'reply';
      l.nextAt = Date.now() + gap * 1000;
    } else {
      l.phase = 'reply';
      l.nextAt = 0;
    }
    await saveLp(l);
    return;
  }

  /* 这条不回、但内容值得让粉丝看见：转出去。
   * 放在「只关注」前面，因为转推要这条推文还在眼前，关注得跳去主页 ——
   * 顺序反了就得重新翻回来找这条，翻不到就只能整页跳，更假。
   * 两个都够格的话，doRepostTask 会连着把关注也做掉（页面那边先转后关）。 */
  if (row.state === '跳过' && row.repost > 0) {
    row.state = '只转推';
    /* 跟引用同一个道理：转推也是几分钟的活（读 + 点 + 验证 + 可能顺手关注），
     * 崩了之后不能把这条当成待回去回。 */
    l.inflight = { url: row.url, at: Date.now(), kind: 'repost', tmo: 200000 };
    await saveLp(l);

    const res = (await doRepostTask(row, s, c)) || {};
    /* 转推要几秒到十几秒，这期间可能点了停止又立刻重开 ——
     * 那就不是这个循环的事了，一个字都不能写回去。 */
    if (!current()) return;

    /* skipped 是「名额用完 / 关掉了 / 这条转过了」，那是正常放过，
     * 不该在卡片上标成失败 */
    row.state = res.ok ? '已转推' : (res.skipped ? '跳过' : (res.already ? '已转过' : '转推失败'));
    l.inflight = null;

    if (!alive()) {
      await saveLp(l);
      await log((res.ok ? '这条转出去了' : '转推没成') + '，已停止');
      return;
    }

    l.idx++;
    if (res.ok) {
      /* 转完停一会儿。转推本身很快，连着转两条比连着回帖更显眼。 */
      const gap = pickGap(20, 60);
      l.phase = 'reply';
      l.nextAt = Date.now() + gap * 1000;
    } else {
      l.phase = 'reply';
      l.nextAt = 0;
    }
    await saveLp(l);
    return;
  }

  /* 这条不回、但作者够格：只走关注那一步，不生成、不填框。
   * 真人看到一条有意思的东西，可能没话说但会点进主页关注一下。 */
  if (row.state === '跳过' && row.follow > 0) {
    row.state = '只关注';
    await saveLp(l);
    const res = await doFollowTask(row.handle, row.url, s, c, row.why || '内容有意思，顺手关注');
    l.idx++;
    /* 关注完停一会儿再处理下一条。连着点关注比连着回帖更容易被盯上。 */
    if (res && res.ok) {
      const gap = pickGap(15, 45);
      l.phase = 'reply';
      l.nextAt = Date.now() + gap * 1000;
    } else {
      l.phase = 'reply';
      l.nextAt = 0;
    }
    await saveLp(l);
    return;
  }

  // 失败的不算"抓过"，下一轮再给一次机会；失败两次才彻底放弃
  const giveUp = async () => {
    const n = (l.retry[row.url] || 0) + 1;
    l.retry[row.url] = n;
    if (n >= 2) return;
    const k = s.seenUrls.indexOf(row.url);
    if (k >= 0) s.seenUrls.splice(k, 1);
    const j = l.seenThisRun.indexOf(row.url);
    if (j >= 0) l.seenThisRun.splice(j, 1);
    await saveSt(s);
    await log('  这条下轮再试一次');
  };

  if (!l.seenThisRun.includes(row.url)) l.seenThisRun.push(row.url);

  /* 1) 生成
   * prepDone 为真说明这条已经生成过了，上次是在等「读 + 想」的时间，
   * 这次进来直接用存好的回复往下走 —— 不能重新调模型，
   * 那样每条会生成两遍，白花钱还可能换一个不一样的说法。 */
  let text = row.reply || '';

  if (!row.prepDone) {
    const style = STYLES[(l.styleIdx++) % STYLES.length];
    const len = pickLen();
    const genAt = Date.now();   // 模型花的这几秒算「思考」的一部分，下面要扣掉
    try {
      const raw = await callModel(buildPrompt(row.text, '自动判断', '自动', 1, style, len, row.angle));
      text = (parseBlocks(raw)[0] || '').trim();
    } catch (e) {
      l.fail++;
      row.state = '生成失败';
      l.idx++;
      await saveLp(l);
      await log('生成失败：' + e.message);
      await giveUp();
      return;
    }
    if (!text) {
      l.fail++; row.state = '空回复'; l.idx++;
      await saveLp(l);
      await log('生成是空的，跳过');
      await giveUp();
      return;
    }
    if (xlen(text) > 280) {
      /* 超长是「这条不发了」，不是「发失败了」。算进 fail 会让失败数虚高，
       * 看着像模型老出错。卡片上标「超长跳过」已经够清楚。 */
      row.state = '超长跳过'; l.idx++;
      await saveLp(l);
      await log('超过 280，跳过：' + text.slice(0, 18) + '…');
      return;
    }
    row.reply = text;

    /* ── 把「读」和「想」的时间补上 ──
     * 模型几秒就写完了，真人不可能。剩下的打字和检查交给页面那边做
     * （dispatch 时传 typeMs / checkMs），这里只等读帖 + 思考。
     *
     * 为什么不用 await sleep 干等：MV3 的 service worker 空闲 30 秒就被回收，
     * 等 90 秒必然被杀，醒来状态全丢。所以改成设 nextAt 让 pump 下次再来 ——
     * 状态在 storage 里，worker 被杀也不影响，最多晚几十秒。
     */
    const tm = humanTiming(row.tlen || row.text, text);
    const spent = (Date.now() - genAt) / 1000;
    const wait = Math.max(3, tm.read + tm.think - spent);

    row.prepDone = true;
    row.typeMs = tm.type * 1000;
    row.checkMs = tm.check * 1000;

    l.phase = 'reply';
    l.nextAt = Date.now() + wait * 1000;
    await saveLp(l);
    /* 这行日志很重要：不加的话面板上会空白一分多钟，
     * 看着像卡住了。它自己解释自己。 */
    await log('看这条…（读 ' + tm.read + ' 秒、想 ' + tm.think + ' 秒，' +
              fmtSec(wait) + '后开始回）');
    return;
  }

  /* 生成要几秒，这期间用户可能已经点了停止 —— 那就别接着发了。
   * current() 是「还是同一个循环」，用来区分两种情况：
   *   只是点了停止  → 可以把「已停止」写回卡片，让人看得见
   *   停了又立刻开始 → 绝对不能写，否则旧任务会把新循环的状态盖掉 */
  if (!alive()) {
    if (current()) {
      row.state = '已停止';
      await saveLp(l);
      await log('已停止，这条没发');
    }
    return;
  }

  // 2) 填 / 发
  /* 超时跟着放宽：原来 175 秒是回复 + 关注，现在还要加上打字和检查。
   * 这个数同时写进 inflight —— worker 被杀之后，重启那边按它判断
   * 「还在做」还是「不会回来了」。两处必须是同一个数。 */
  const tmo = 175000 + (row.typeMs || 0) + (row.checkMs || 0);
  l.inflight = { url: row.url, at: Date.now(), kind: 'reply', tmo };
  await saveLp(l);

  try {
    /* 这条既回又关注：把 handle 一起带过去，回完顺手关注。
     * 不在回完之后单独派一次 —— 那时候页面已经离开那条推文了，
     * 找不到作者链接，只能整页跳，反而更假。 */
    const fh = (row.follow > 0 && row.handle && canFollow(row.handle, s, c)) ? row.handle : '';

    if (l.dryRun) {
      await dispatch({
        type: 'reply', url: row.url, text, send: false,
        typeMs: row.typeMs || 0, checkMs: row.checkMs || 0,
      }, tmo);
      row.state = '已填';
    } else {
      const r = await dispatch({
        type: 'reply', url: row.url, text, send: true, followHandle: fh,
        typeMs: row.typeMs || 0, checkMs: row.checkMs || 0,
      }, tmo);

      /* 页面明确说没发出去：不能写「已发」、不能计入今日数、也不能重试。
       * 不确定它到底发没发，按「不确定」处理（跟 worker 被杀那条同一个语义）。
       * 以前这里无条件写「已发 +1」并打「已回：」——
       * 页面要是返回了个空结果，日志会骗人，今日计数也会虚高。 */
      if (!r || !r.sent) {
        row.state = '不确定';
        l.inflight = null;
        l.idx++;
        await saveLp(l);
        await log('  ⚠ 页面没确认发出去（' +
                  (r ? JSON.stringify(r).slice(0, 60) : '空结果') +
                  '），这条按不确定处理，不重试');
        return;
      }

      row.state = '已发';
      /* 这条是真发出去了，今日计数必须记上 —— 哪怕用户刚刚点了停止。
       * 漏记会让「今日已发」比实际少，下次启动又多放几条出去。 */
      s.sentToday++;
      s.sentUrls.push(row.url);
      await saveSt(s);
      /* 正常情况下是滚着时间线找到这条的；如果退化成整页跳转，
       * 说明翻不到了，写一行出来，省得以后不知道为什么像机器 */
      if (r.how === 'jump') await log('  时间线上没翻到这条，直接跳过去了');

      /* 关注结果单独看。关注没成不影响这条回复 —— 回复早就发出去了。 */
      if (fh) {
        const fr = r.follow || null;
        if (fr && fr.ok && !fr.already) {
          await markFollowed(fh, s, row.why || '回帖时顺手关注');
          await log('  顺手关注了 @' + fh + '（今日第 ' + (s.followToday || 0) + ' 个）' +
                    (fr.requested ? '，对方是受保护账号，只发了请求' : ''));
        } else if (fr && fr.already) {
          await log('  @' + fh + ' 本来就是关注状态');
        } else {
          await log('  关注 @' + fh + ' 没成：' + ((fr && fr.why) || '页面没给结果'));
          await markFollowFailed(fh, s);
        }
      }
    }
  } catch (e) {
    l.fail++;
    row.state = '失败';
    l.inflight = null;
    l.idx++;
    if (!alive()) {
      if (current()) {
        await saveLp(l);
        await log('这条没成：' + e.message + '（已停止）');
      }
      return;
    }
    await saveLp(l);
    await log('这条没成：' + e.message);
    await giveUp();
    return;
  }

  l.sent++;
  l.inflight = null;
  l.idx++;

  /* 停止是在这条发送途中点的：字已经填好、按钮也点了，撤不回来。
   * 那就发完为止，但不再做顺手动作、不再等间隔、不再进下一轮。
   * 注意 current() —— 停了又立刻重开的话，这里一个字都不能写，
   * 否则旧任务会把新循环的状态盖掉（这是比"停不下来"更坏的 bug）。 */
  if (!alive()) {
    if (current()) {
      await saveLp(l);
      await log((l.dryRun ? '这条填完了' : '这条发完了') + '，已停止');
    }
    return;
  }
  await saveLp(l);
  await log(l.dryRun ? '试填（没发）：' + text : '已回：' + text);

  // 3) 穿插一点真人动作：滑动、停留、点赞
  if (c.human) {
    try {
      /* 点赞率 30%。以前是 60%，等于回两条点一个多，而且每次都是
       * 「回复 + 点赞同一条」，这个组合太规律了。 */
      const h = await dispatch({ type: 'humanize', url: row.url, like: Math.random() < 0.3 }, 45000);
      if (h && h.acts && h.acts.length && current()) {
        row.acts = h.acts;      // 记到这张卡片上，面板里能看见这条顺手做了什么
        await saveLp(l);
        await log('  顺手：' + h.acts.join('、'));
      }
    } catch (e) { /* 真人动作失败无所谓 */ }
  }

  if (!alive()) return;

  /* 4) 这条回完了。看这一段是不是该收了 ——
   * 收了就走开，没收到就等条间隔接着回下一条。 */
  l.sessionDone = (l.sessionDone || 0) + 1;

  if (l.sessionDone >= l.sessionTarget) {
    const done = l.sessionDone;
    const sessMin = Math.max(1, Math.round((Date.now() - (l.sessionStartAt || Date.now())) / 60000));
    const away = pickAwayMin(c, sessMin);
    l.phase = 'away';
    l.nextAt = Date.now() + away * 60000;
    l.sessionTarget = 0; l.sessionDone = 0; l.emptyRounds = 0;
    await saveLp(l);
    await log('这段坐了 ' + sessMin + ' 分钟，回了 ' + done + ' 条，走开 ' + fmtSec(away * 60));
    return;
  }

  const stepSec = pickStepSec(c);
  l.phase = 'wait';
  l.nextAt = Date.now() + stepSec * 1000;
  await saveLp(l);
  await log('等 ' + fmtSec(stepSec) + '（这段还差 ' + (l.sessionTarget - l.sessionDone) + ' 条）');
}

async function loopStart(limit, dryRun) {
  const c = await cfg();
  if (!c.key) throw new Error('还没填 API Key。点右上角「设置」粘一个进来就行（接口地址已经默认是 DeepSeek）。');
  const tab = await findXTab();
  if (!tab) throw new Error('没找到打开的 x.com 标签页。先打开一个 x.com 页面（停在你要抓的 tab 上）。');

  const l = await lp();
  if (l.running) throw new Error('已经在跑了');

  const fresh = Object.assign({}, DEF_LOOP, {
    running: true,
    dryRun: !!dryRun,
    limit: Math.min(30, Math.max(1, +limit || c.limit || 10)),
    round: 0, sent: 0, fail: 0,
    phase: 'fetch', nextAt: 0, idx: 0, batch: [],
    log: [],
    styleIdx: Math.floor(Math.random() * STYLES.length),
    retry: {}, seenThisRun: [], inflight: null,
  });
  await saveLp(fresh);

  /* 扩展更新之后，已经打开的 x.com 标签页里跑的还是**旧** content script
   * （Chrome 不会热替换已注入的脚本）。两边版本对不上会出很怪的错：
   * 比如页面返回的对象里少了个字段，后台就只能报「页面没给结果」，
   * 日志完全看不出原因，还以为是 DOM 变了。
   * findXTab 刚才 ping 过，extVer 就是页面自己报的版本。 */
  if (extVer && extVer !== VER) {
    await log('⚠ 页面跑的是旧版脚本（' + extVer + '，扩展已经是 ' + VER + '）。' +
              '刷新一下 x.com 那个标签页再开始，不然会出奇怪的错');
  }

  await log('开始 · tab「' + c.tabLabel + '」· 每轮抓 ' + fresh.limit + ' 条' +
      '、挑 ' + c.pickMin + '~' + c.pickMax + ' 条回' + (c.screen ? '（先让模型挑，挑不出就空着翻下一批）' : '（随机挑）') +
      ' · 坐下回 ' + c.sessMin + '~' + c.sessMax + ' 条、条间隔 ' + c.stepMin + '~' + c.stepMax + ' 秒' +
      '、走开 ' + c.awayMin + '~' + c.awayMax + ' 分钟' +
      (c.human ? ' · 穿插点赞滑动' : '') +
      (c.autoFollow ? ' · 顺手关注（每天最多 ' + c.followDaily + ' 个）' : ' · 不关注') +
      (c.autoRepost ? ' · 偶尔转推（每天抽 0~' + c.repostDaily + ' 个）' : ' · 不转推') +
      (c.autoQuote ? ' · 偶尔引用（每天抽 0~' + c.quoteDaily + ' 个）' : ' · 不引用') +
      (fresh.dryRun ? ' · 试运行（只填不发）' : ''));

  pump();
  return { ok: true };
}

async function loopStop() {
  const l = await lp();
  const busyOne = !!l.inflight;   // 点停止的时候正好有一条在发
  l.running = false;
  l.phase = 'idle';
  l.nextAt = 0;
  l.inflight = null;
  await saveLp(l);
  await log(busyOne
    ? '停了（刚才那条已经填好正在发，发完就真停，不会再来下一条）'
    : '停了。本次回复 ' + l.sent + ' 条，失败 ' + l.fail + ' 条');
  return { ok: true };
}

/* ────────────── 给面板用的接口 ────────────── */

function sanitizeCfg(next, prev) {
  if (typeof next.persona !== 'string' || !next.persona.trim()) next.persona = DEF_PERSONA;
  next.limit = Math.min(30, Math.max(1, +next.limit || 10));
  /* 会话制参数。上限都收着点，填飞了整个节奏就废了 */
  next.sessMin = Math.min(30, Math.max(1, Math.round(+next.sessMin || 4)));
  next.sessMax = Math.min(30, Math.max(next.sessMin, Math.round(+next.sessMax || 9)));
  next.stepMin = Math.min(600, Math.max(20, Math.round(+next.stepMin || 80)));
  next.stepMax = Math.min(900, Math.max(next.stepMin, Math.round(+next.stepMax || 170)));
  next.awayMin = Math.min(240, Math.max(3, Math.round(+next.awayMin || 15)));
  next.awayMax = Math.min(360, Math.max(next.awayMin, Math.round(+next.awayMax || 45)));
  /* 老配置里的四档 / 休息字段清掉，免得以后看着两个来源犯迷糊 */
  delete next.gapMin; delete next.gapMax; delete next.gapMode;
  delete next.restEvery; delete next.restMin; delete next.restMax;
  next.human = next.human !== false;
  next.dailyMax = Math.min(500, Math.max(1, +next.dailyMax || 60));
  /* 老配置里的「每轮怎么回」删了：现在固定是"挑几条回" */
  delete next.pick;
  next.screen = next.screen !== false;
  next.windows = String(next.windows == null ? '' : next.windows).trim();
  /* 挑几条不能超过每轮抓的条数，否则「随机挑 1~8」配上「每轮抓 5」就自相矛盾 */
  next.pickMin = Math.min(next.limit, Math.max(1, +next.pickMin || 1));
  next.pickMax = Math.min(next.limit, Math.max(next.pickMin, +next.pickMax || 3));
  next.tabLabel = String(next.tabLabel || '').trim() || '加密';
  next.base = String(next.base || '').trim() || DEF_CONFIG.base;
  next.model = String(next.model || '').trim() || 'deepseek-chat';
  /* 自动关注。日限额上限压到 100 —— 再多就不像人手动点的了。
   * followDaily 允许填 0（等于这次不关注），所以不能用 `|| 40` 兜底，
   * 0 是 falsy，会被悄悄改回 40。 */
  next.autoFollow = next.autoFollow !== false;
  next.followDaily = Math.min(100, Math.max(0,
    Math.round(next.followDaily == null || next.followDaily === '' ? 40 : +next.followDaily)));
  next.followMinScore = Math.min(3, Math.max(1, Math.round(+next.followMinScore || 2)));
  next.followMaxReplies = Math.min(5000, Math.max(10, Math.round(+next.followMaxReplies || 150)));
  next.followMaxLikes = Math.min(100000, Math.max(50, Math.round(+next.followMaxLikes || 3000)));
  /* 转推 / 引用。上限都压着 —— 这两个是在拿自己的信用背书。
   * 注意这两个数现在是「配额上限」，实际每天从 0~这个数里现抽一个。
   * 都允许填 0（等于这次不动），所以不能用 `|| 2` 兜底。 */
  next.autoRepost = next.autoRepost !== false;
  next.repostDaily = Math.min(10, Math.max(0,
    Math.round(next.repostDaily == null || next.repostDaily === '' ? 2 : +next.repostDaily)));
  next.autoQuote = next.autoQuote !== false;
  next.quoteDaily = Math.min(10, Math.max(0,
    Math.round(next.quoteDaily == null || next.quoteDaily === '' ? 3 : +next.quoteDaily)));
  next.quoteMaxReplies = Math.min(5000, Math.max(10, Math.round(+next.quoteMaxReplies || 150)));
  /* 老的「转推门槛 / 掷骰子」删掉 —— 现在门槛写在 r 分里（3 引 2 转），
   * 数量靠每天现抽的配额控制，留着两个旧字段只会让人以为还能调。 */
  delete next.repostMinScore; delete next.repostChance;
  /* 面板里显示的是掩码，真把掩码存回来时必须换回原来的 Key，不能直接删 */
  if (typeof next.key === 'string' && /^•+$/.test(next.key.trim())) next.key = (prev && prev.key) || '';
  return next;
}

async function snapshot() {
  const c = await cfg();
  const s = await st();
  const l = await lp();
  await rollDay();
  const tab = await findXTabCached();
  /* 页面正在硬刷新（每轮第二次起都会刷）的那几秒 ping 不通，
   * 6 秒内刚通过就不算「未打开」，省得状态栏一直闪。 */
  const pageOk = !!tab || (Date.now() - lastPingOkAt < 6000);

  return {
    ver: VER,
    extVer,
    pageOk,
    pageUrl: tab ? tab.url : '',
    /* 页面在不在前台。
     *   state=hidden  → 浏览器停掉渲染，时间线不再出新的，看着像卡住
     *   stale=true    → 连心跳都不来了，标签页多半被关了或者整个卡死
     * 两个都要报：只有 hidden 的时候才值得提醒「切回前台」，
     * stale 是另一回事，得让人去查那个页面还在不在。 */
    vis: (() => {
      const v = CACHE.vis;
      if (!v) return null;
      return { state: v.state, stale: Date.now() - v.at > 90000 };
    })(),
    hasModel: !!(c.base && c.key),
    sentToday: s.sentToday,
    dailyMax: c.dailyMax,
    followToday: s.followToday || 0,
    followDaily: c.followDaily,
    /* 关注底账。days = 关注了几天，due = 满 7 天该回看一眼。
     * 取关由作者自己手动做，这里只负责把「跟了一周了」的号翻出来，
     * 免得关注列表越滚越长、时间线越来越脏还没人管。 */
    followLog: (s.followLog || []).slice(-80).map((x) => {
      const days = Math.floor((Date.now() - (+x.at || 0)) / 86400000);
      return { h: x.h, at: x.at, why: x.why, days, due: days >= 7 };
    }),
    /* 转推底账。只留最近 20 条 —— 一天一两个，20 条够看十天了。
     * 这张表的主要作用不是展示，是让作者能回头核对「我真转过这条吗」。 */
    repostToday: s.repostToday || 0,
    repostDaily: c.repostDaily,
    repostTarget: s.repostTarget == null ? -1 : s.repostTarget,
    repostLog: (s.repostLog || []).slice(-20).map((x) => ({
      h: x.h || '', at: x.at, why: x.why,
      days: Math.floor((Date.now() - (+x.at || 0)) / 86400000),
    })),
    /* 引用底账。多一份正文 —— 引用是永久帖，作者必须能看见程序替他发了什么。 */
    quoteToday: s.quoteToday || 0,
    quoteDaily: c.quoteDaily,
    quoteTarget: s.quoteTarget == null ? -1 : s.quoteTarget,
    quoteLog: (s.quoteLog || []).slice(-20).map((x) => ({
      h: x.h || '', at: x.at, text: x.text || '',
      days: Math.floor((Date.now() - (+x.at || 0)) / 86400000),
    })),
    cfg: {
      base: c.base, key: c.key ? '••••••' : '', model: c.model, persona: c.persona,
      sessMin: c.sessMin, sessMax: c.sessMax,
      stepMin: c.stepMin, stepMax: c.stepMax,
      awayMin: c.awayMin, awayMax: c.awayMax,
      human: c.human, dailyMax: c.dailyMax, tabLabel: c.tabLabel,
      pickMin: c.pickMin, pickMax: c.pickMax,
      screen: c.screen, windows: c.windows,
      timelineUrl: c.timelineUrl, limit: c.limit,
      autoFollow: c.autoFollow, followDaily: c.followDaily, followMinScore: c.followMinScore,
      followMaxReplies: c.followMaxReplies, followMaxLikes: c.followMaxLikes,
      autoRepost: c.autoRepost, repostDaily: c.repostDaily,
      autoQuote: c.autoQuote, quoteDaily: c.quoteDaily, quoteMaxReplies: c.quoteMaxReplies,
    },
    loop: {
      running: l.running, dryRun: l.dryRun, round: l.round,
      sent: l.sent, fail: l.fail, limit: l.limit,
      phase: l.phase,
      waitLeft: l.nextAt > Date.now() ? Math.ceil((l.nextAt - Date.now()) / 1000) : 0,
      /* 正在「读这条、想怎么说」：回复已经生成好了，但还在等那几十秒。
       * 面板上要单独说一句，不然显示成「等下一条 35s」会让人以为卡住了 ——
       * 明明是在干活，看着像在发呆。 */
      reading: !!(l.batch && l.batch[l.idx] && l.batch[l.idx].prepDone &&
                  l.batch[l.idx].reply && l.phase === 'reply' && !l.inflight),
      sessionTarget: l.sessionTarget || 0,
      sessionDone: l.sessionDone || 0,
      batch: l.batch, log: l.log.slice(-40),
    },
  };
}

const API = {
  'xr:get': () => snapshot(),

  'xr:saveCfg': async (m) => {
    const cur = await cfg();
    const next = sanitizeCfg(Object.assign({}, cur, m.patch || {}), cur);
    await saveCfg(next);
    return { ok: true, cfg: { base: next.base, model: next.model } };
  },

  'xr:loopStart': (m) => loopStart(m.limit, m.dryRun),
  'xr:loopStop': () => loopStop(),

  /* 配完模型点一下就能验证通不通，不用等真跑循环才发现 */
  'xr:testModel': async () => {
    const t0 = Date.now();
    const raw = await callModel(buildPrompt('今天 BTC 又回踩 6 万了，山寨一点反应都没有', '自动判断', '自动', 1, STYLES[0]));
    const out = (parseBlocks(raw)[0] || '').trim();
    return { ms: Date.now() - t0, sample: out };
  },

  'xr:reset': async () => {
    const s = await st();
    s.sentUrls = []; s.seenUrls = []; s.sentToday = 0;
    await saveSt(s);
    const l = await lp();
    l.batch = []; l.log = []; l.retry = {}; l.seenThisRun = []; l.round = 0; l.sent = 0; l.fail = 0;
    await saveLp(l);
    return { ok: true };
  },

  'xr:openTab': async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('panel.html?full=1') });
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  /* 页面心跳：主驱动。收到就顺手推一把引擎（没到点的话什么都不做） */
  if (msg.type === 'tick') {
    /* 页面在不在前台。只放内存，不写 storage —— 每 1.5 秒写一次盘太浪费，
     * 而且这个值丢了也无所谓，下一次心跳（最多 8 秒后）就补回来了。
     * worker 被杀重启时 CACHE 清空，那时面板会显示「不知道」，
     * 等一个心跳周期就恢复。 */
    CACHE.vis = {
      /* 只认这两个值。老版本的 content script 不带这个字段，
       * 或者将来哪天字段改名了，宁可显示「不知道」也别瞎报「在后台」。 */
      state: (msg.vis === 'visible' || msg.vis === 'hidden') ? msg.vis : '?',
      at: Date.now(),
    };
    pump();
    /* 顺手告诉页面「现在在等间隔」—— 让它自己慢慢往下滑，
     * 别钉在一条推文上僵两分钟。
     * 再报一下还要等多久：等得久的话页面会把心跳放慢，
     * 不然「久」档那 40~90 分钟里每 1.5 秒戳一次后台，等于让扩展一直醒着。 */
    const l = CACHE.lp;
    /* 走开 / 等时间段的时候别滚：那两段的语义就是人不在，
     * 页面还在自己往下滑反而不对。
     * 只有「这一段还坐着，等条间隔」的时候才让页面慢慢看。 */
    const browse = !!(l && l.running && !l.inflight && l.phase !== 'away' &&
                      l.phase !== 'window' && l.nextAt && Date.now() < l.nextAt);
    const waitLeft = l && l.nextAt ? Math.max(0, Math.ceil((l.nextAt - Date.now()) / 1000)) : 0;
    sendResponse({ ok: true, browse, waitLeft });
    return false;
  }

  /* 页面里所有 sleep 的计时器都在这里跑。
   *
   * 为什么不在页面里等：页面切到后台之后，Chrome 会把它的定时器压到
   * 1 秒一次，隐藏超过 5 分钟压到 60 秒一次。一条回复里有十几次
   * 几百毫秒到几秒的等待，全被拉长就等于停摆。
   * service worker 没有可见性概念，setTimeout 不受这个影响。
   *
   * 只要 sendResponse 没调用，worker 就不会被回收，所以几秒级的等待是安全的。
   * 上限 2 分钟：真有人传更大的值，宁可提前放行也别让页面干等。 */
  if (msg.type === 'nap') {
    const ms = Math.min(120000, Math.max(0, Math.round(+msg.ms || 0)));
    setTimeout(() => { try { sendResponse({ ok: true }); } catch (e) {} }, ms);
    return true;
  }

  /* 页面整跳后接力回来的结果 */
  if (msg.type === 'taskResult') {
    lateWatch.delete(msg.id);
    settle(msg);
    sendResponse({ ok: true });
    return false;
  }

  const fn = API[msg.type];
  if (fn) {
    (async () => {
      try { sendResponse({ ok: true, data: await fn(msg) }); }
      catch (e) { sendResponse({ ok: false, error: (e && e.message) || String(e) }); }
    })();
    return true; // 异步回
  }
});

/* ────────────── 心跳、注入、侧边栏 ────────────── */

/* 备用心跳：标签页切到后台时 tick 会被浏览器节流到 1 分钟一次，
 * 闹钟能保证引擎还在往前走。 */
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'xr-pump') pump();
});

async function ensureAlarm() {
  try { await chrome.alarms.create('xr-pump', { periodInMinutes: 0.5 }); } catch (e) {}
}

/* 装扩展之前就开着的 x.com 页面不会自动注入，得补一次 */
async function ensureInjected() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] }); }
  catch (e) { return; }

  for (const t of tabs) {
    try {
      const r = await chrome.tabs.sendMessage(t.id, { type: 'ping' });
      if (r && r.ok) continue;
    } catch (e) { /* 没注入，下面补 */ }
    try { await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] }); }
    catch (e) { /* 受限页面，跳过 */ }
  }
}

function setupAction() {
  // 点图标直接开侧边栏（Chrome 114+）
  try {
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    }
  } catch (e) {}
}

chrome.action.onClicked.addListener(async (tab) => {
  // 老版本 Chrome 没有 setPanelBehavior 时的兜底：开成一个标签页
  try {
    if (chrome.sidePanel && chrome.sidePanel.open && tab && tab.windowId != null) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      return;
    }
  } catch (e) {}
  chrome.tabs.create({ url: chrome.runtime.getURL('panel.html?full=1') });
});

chrome.runtime.onInstalled.addListener(() => { setupAction(); ensureAlarm(); ensureInjected(); });
chrome.runtime.onStartup.addListener(() => { setupAction(); ensureAlarm(); ensureInjected(); });

setupAction();
ensureAlarm();
ensureInjected();
