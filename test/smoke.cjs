/**
 * 离线冒烟测试：不启动 DSH，直接在 vm 里执行已构建的客户端 bundle，
 * 用断言覆盖模块形态、渲染矩阵、金额边界、按需取数与诊断。
 *
 * 运行：node test/smoke.cjs      （失败时以非零退出）
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const bundlePath = path.join(__dirname, '..', 'lib', 'client.js');
const source = fs.readFileSync(bundlePath, 'utf8');

const failures = [];
let checks = 0;
function check(label, fn) {
  checks++;
  try {
    fn();
  } catch (error) {
    failures.push(label + ' → ' + error.message);
  }
}

//#region 假运行时
/** 一个受控的 Remote account 命名空间 + 假 document/定时器，用于驱动插件。 */
function createHarness(options = {}) {
  const calls = { status: 0, balance: 0, meta: [] };
  const intervals = [];
  let balances = options.balances ?? [{ currency: 'CNY', balance: '5.3671409600000000' }];
  let bonus = options.bonus ?? [{ currency: 'CNY', balance: '0' }];
  let status = options.status ?? 'credential-stored';
  let balanceError = options.balanceError ?? null;
  let statusError = options.statusError ?? null;
  const logs = [];
  const visibility = { state: options.visible === false ? 'hidden' : 'visible' };
  const listeners = { visibilitychange: [] };
  const frames = [];
  let frameWake = null;

  const stream = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          while (frames.length === 0) await new Promise((resolve) => { frameWake = resolve; });
          return { value: frames.shift(), done: false };
        },
      };
    },
    async dispose() {},
  };

  const sandbox = {
    window: {},
    console: {
      log: (...args) => logs.push(args.join(' ')),
      info: (...args) => logs.push(args.join(' ')),
      warn: (...args) => logs.push(args.join(' ')),
    },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {},
    document: {
      get visibilityState() { return visibility.state; },
      addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
      removeEventListener: (type, fn) => { listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn); },
      querySelector: () => null,
      createElement: () => ({ dataset: {} }),
      head: { appendChild: () => {} },
    },
  };
  sandbox.window.__ModuleLoader__ = { load: (value) => { sandbox.__spec = value; } };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: bundlePath });
  const spec = sandbox.__spec;
  if (!spec) throw new Error('bundle 没有注册模块');

  const modules = {
    react: {
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      memo: (fn) => fn,
    },
    '@deepseek-ai/dsh-client-ui-primitives': options.noTooltip
      ? {}
      : { Tooltip: (props) => ({ type: 'Tooltip', props: { ...props }, children: props.children }) },
  };
  const mod = spec.factory((name) => {
    if (modules[name] !== undefined) return modules[name];
    throw new Error('未预期的 require: ' + name);
  });

  const registrations = [];
  const disposers = [];
  const ctx = {
    effect: (fn, label) => {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push([label, dispose]);
      return () => {};
    },
    locale: {
      register: () => () => {},
      getSnapshot: () => ({ active: 'zh' }),
    },
    remote: {
      $stream: options.noStream ? undefined : () => stream,
      account: {
        getState: async () => {
          calls.status++;
          if (statusError !== null) throw statusError;
          return { ok: true, value: { status } };
        },
        getBalance: async (meta) => {
          calls.balance++;
          calls.meta.push(meta);
          if (balanceError !== null) throw balanceError;
          if (options.balanceNull === true) return { ok: true, value: null };
          return { ok: true, value: { status: 'ready', value: balances, bonusWallets: bonus } };
        },
      },
    },
    slots: {
      inject: (name, fn) => { fn(); },
      register: (registration, component) => { registrations.push({ registration, component }); return () => {}; },
    },
  };
  mod.apply(ctx);
  const injected = registrations[0].registration.inject();

  return {
    spec,
    mod,
    logs,
    calls,
    intervals,
    visibility,
    listeners,
    registrations,
    disposeAll: () => { for (const [, dispose] of disposers) dispose(); },
    pushFrame: async (value) => {
      frames.push({ value, accept: () => {} });
      frameWake?.();
      frameWake = null;
      await settle();
    },
    set: (patch) => {
      if (patch.balances) balances = patch.balances;
      if (patch.bonus) bonus = patch.bonus;
      if (patch.status) status = patch.status;
      if ('balanceError' in patch) balanceError = patch.balanceError;
      if ('statusError' in patch) statusError = patch.statusError;
    },
    store: injected.hooks.accountBalance,
    refresh: injected.refresh,
    component: registrations[0].component,
  };
}

/** 让已排队的微任务与 promise 链跑完。 */
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

/** 把 createElement 树渲染成普通对象树，并记录每个按钮上方的 Tooltip 文案。 */
function render(node, title = null) {
  if (node === null || node === undefined || typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map((child) => render(child, title));
  if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }), title);
  if (node.type === 'Tooltip') return render(node.children, node.props.label);
  return { type: node.type, props: node.props, title, children: render(node.children, title) };
}

/** 展平 createElement 里常见的嵌套 children 数组。 */
function flatten(nodes, out = []) {
  if (Array.isArray(nodes)) { for (const node of nodes) flatten(node, out); return out; }
  if (nodes !== null && nodes !== undefined) out.push(nodes);
  return out;
}

/** 取出渲染结果里的所有余额按钮。 */
function pillsOf(tree, found = []) {
  if (tree === null || tree === undefined || typeof tree === 'string') return found;
  if (Array.isArray(tree)) { for (const child of tree) pillsOf(child, found); return found; }
  if (tree.type === 'button') {
    const label = flatten(tree.children).find((child) => child !== null && typeof child === 'object' && child.props?.className === 'dsh-balance-label');
    found.push({
      text: label?.children?.[0] ?? null,
      aria: tree.props['aria-label'] ?? null,
      busy: tree.props['aria-busy'] ?? null,
      currency: tree.props['data-currency'] ?? null,
      title: tree.title ?? null,
    });
    return found;
  }
  pillsOf(tree.children, found);
  return found;
}

const dict = {
  'balance.value': '余额 {amount}',
  'balance.aria': '账号余额 {amount}',
  'balance.unavailable': '余额不可用',
  'balance.aria.unavailable': '账号余额不可用',
  'balance.row.recharge': '充值余额 {amount}',
  'balance.row.bonus': '赠送余额 {amount}',
  'balance.row.updated': '更新于 {time}',
  'balance.row.refresh': '点击刷新',
  'balance.row.retry': '点击重试',
  'balance.row.pending': '正在刷新…',
};
const t = (key, params) => {
  let text = dict[key] ?? key;
  for (const name of Object.keys(params ?? {})) text = text.split('{' + name + '}').join(String(params[name]));
  return text;
};
const view = (harness, snapshot) => pillsOf(render(harness.component({
  useAccountBalance: (select) => select(snapshot ?? harness.store.getSnapshot()),
  t,
  refresh: harness.refresh,
})));

const T = (label) => label.padEnd(34);
//#endregion

(async () => {
  //#region 模块形态
  const module = createHarness();
  check('模块 id 与包名一致', () => assert.equal(module.spec.id, 'dsh-plugin-account-balance'));
  check('导出 apply/inject', () => assert.deepEqual(Object.keys(module.mod).sort(), ['apply', 'inject']));
  check('服务 inject 列表', () => assert.deepEqual([...module.mod.inject], ['slots', 'locale', 'remote', 'remote.account']));
  check('注册进 composer dock 且 order 10', () => {
    const registration = module.registrations[0].registration;
    assert.equal(registration.name, 'conversation.composer.dock');
    assert.equal(registration.id, 'account-balance');
    assert.equal(registration.order, 10);
    assert.equal(registration.locale, 'account-balance');
    assert.equal(typeof registration.inject, 'function');
  });
  check('未订阅时不打扰 Host', () => assert.equal(module.calls.balance, 0));
  check('注册了定时器', () => assert.equal(module.intervals.length, 1));
  module.disposeAll();

  //#region 按需取数
  const lazy = createHarness();
  const unsubscribe = lazy.store.subscribe(() => {});
  await settle();
  check('首个订阅者触发一次读取', () => assert.equal(lazy.calls.balance, 1));
  check('上报的元数据携带版本/语言/时区', () => {
    assert.equal(lazy.calls.meta[0].version, '0.1.7-rc.2');
    assert.equal(lazy.calls.meta[0].locale, 'zh');
    assert.equal(typeof lazy.calls.meta[0].timezoneOffsetSeconds, 'number');
  });
  unsubscribe();
  for (const { fn } of lazy.intervals) fn();
  await settle();
  check('无订阅者时定时器不读取', () => assert.equal(lazy.calls.balance, 1));
  lazy.store.subscribe(() => {});
  await settle();
  const beforeHidden = lazy.calls.balance;
  lazy.visibility.state = 'hidden';
  for (const { fn } of lazy.intervals) fn();
  await settle();
  check('后台标签页的定时器不读取', () => assert.equal(lazy.calls.balance, beforeHidden));
  lazy.visibility.state = 'visible';
  for (const fn of lazy.listeners.visibilitychange) fn();
  await settle();
  check('回到前台立即补一次读取', () => assert.equal(lazy.calls.balance, beforeHidden + 1));
  check('读取失败前的诊断为空', () => assert.deepEqual(lazy.logs, []));
  check('已登录时渲染余额 pill', () => {
    const pills = view(lazy);
    assert.equal(pills.length, 1);
    assert.equal(pills[0].text, '余额 ¥5.36');
    assert.equal(pills[0].aria, '账号余额 ¥5.36');
    assert.equal(pills[0].currency, 'CNY');
    assert.match(pills[0].title, /充值余额 ¥5\.36/);
    assert.match(pills[0].title, /点击刷新$/);
  });
  lazy.disposeAll();

  //#region 账号状态帧
  const streamed = createHarness({ status: 'credential-stored' });
  streamed.store.subscribe(() => {});
  await settle();
  const baseline = streamed.calls.balance;
  await streamed.pushFrame({ status: 'something-new' });
  check('认不出的帧不清空余额', () => {
    const pills = view(streamed);
    assert.equal(pills.length, 1);
    assert.equal(pills[0].text, '余额 ¥5.36');
  });
  check('认不出的帧记一次诊断', () => {
    assert.equal(streamed.logs.filter((line) => line.includes('无法识别的账号状态')).length, 1);
  });
  check('认不出的帧不触发读取', () => assert.equal(streamed.calls.balance, baseline));
  await streamed.pushFrame({ status: 'signed-out' });
  check('登出帧清空并停止渲染', () => assert.deepEqual(view(streamed), []));
  await streamed.pushFrame({ status: 'credential-stored' });
  check('重新登录帧触发读取', () => assert.equal(streamed.calls.balance, baseline + 1));
  check('重新登录后又渲染余额', () => assert.equal(view(streamed)[0].text, '余额 ¥5.36'));
  streamed.disposeAll();

  //#region 失败与登录态
  const signedInFailure = createHarness({ status: 'credential-stored', balanceError: new Error('boom') });
  signedInFailure.store.subscribe(() => {});
  await settle();
  check('已登录 + 读取失败 → 余额不可用', () => {
    const pills = view(signedInFailure);
    assert.equal(pills.length, 1);
    assert.equal(pills[0].text, '余额不可用');
    assert.equal(pills[0].aria, '账号余额不可用');
    assert.match(pills[0].title, /点击重试$/);
  });
  check('读取失败记一次诊断', () => {
    assert.equal(signedInFailure.logs.filter((line) => line.includes('余额读取失败')).length, 1);
  });
  signedInFailure.disposeAll();

  const signedOut = createHarness({ status: 'signed-out', balanceError: new Error('boom') });
  signedOut.store.subscribe(() => {});
  await settle();
  check('未登录时不去读余额', () => assert.equal(signedOut.calls.balance, 0));
  check('未登录时不渲染（也不报错）', () => assert.deepEqual(view(signedOut), []));
  signedOut.disposeAll();

  const unknownState = createHarness({ statusError: new Error('no transport'), balanceError: new Error('boom') });
  unknownState.store.subscribe(() => {});
  await settle();
  check('登录态未知 + 读取失败 → 保持静默', () => assert.deepEqual(view(unknownState), []));
  check('登录态未知也留下诊断', () => {
    assert.equal(unknownState.logs.filter((line) => line.includes('账号状态读取失败')).length, 1);
  });
  unknownState.disposeAll();

  const stale = createHarness();
  stale.store.subscribe(() => {});
  await settle();
  stale.set({ balanceError: new Error('later') });
  stale.refresh();
  await settle();
  check('失败时保留上一次成功值', () => assert.equal(view(stale)[0].text, '余额 ¥5.36'));
  stale.disposeAll();

  const noStream = createHarness({ noStream: true });
  noStream.store.subscribe(() => {});
  await settle();
  check('没有状态流时靠 getState 兜底', () => {
    assert.equal(noStream.calls.status, 1);
    assert.equal(view(noStream)[0].text, '余额 ¥5.36');
  });
  noStream.disposeAll();

  const nullBalance = createHarness({ statusError: new Error('no transport'), balanceNull: true });
  nullBalance.store.subscribe(() => {});
  await settle();
  check('余额返回 null → 权威地判定未登录且不渲染', () => {
    assert.deepEqual(view(nullBalance), []);
    assert.equal(nullBalance.store.getSnapshot().signedIn, false);
    assert.equal(nullBalance.store.getSnapshot().phase, 'signed-out');
  });
  nullBalance.disposeAll();

  //#region 刷新反馈
  const pending = createHarness();
  pending.store.subscribe(() => {});
  await settle();
  pending.refresh();
  check('点击刷新期间 pill 标记 aria-busy', () => {
    const pills = view(pending);
    assert.equal(pills[0].busy, 'true');
    assert.match(pills[0].title, /正在刷新…$/);
  });
  await settle();
  check('刷新结束后回到点击刷新', () => {
    const pills = view(pending);
    assert.equal(pills[0].busy, null);
    assert.match(pills[0].title, /点击刷新$/);
  });
  pending.disposeAll();

  //#region 多币种与金额边界
  const multi = createHarness({
    balances: [{ currency: 'CNY', balance: '12.3456' }, { currency: 'USD', balance: '1.5' }],
    bonus: [{ currency: 'CNY', balance: '3' }, { currency: 'USD', balance: '0' }, { currency: 'CNY', balance: '0' }],
  });
  multi.store.subscribe(() => {});
  await settle();
  check('多币种各一枚 pill（不跨币种求和）', () => {
    const pills = view(multi);
    assert.deepEqual(pills.map((pill) => [pill.currency, pill.text]), [
      ['CNY', '余额 ¥12.34'],
      ['USD', '余额 $1.50'],
    ]);
    assert.match(pills[0].title, /赠送余额 ¥3\.00/);
    assert.doesNotMatch(pills[0].title, /赠送余额 ¥0\.00/);
    assert.match(pills[1].title, /充值余额 \$1\.50/);
  });
  multi.disposeAll();

  const bonusOnly = createHarness({ balances: [], bonus: [{ currency: 'USD', balance: '2.5' }] });
  bonusOnly.store.subscribe(() => {});
  await settle();
  check('只有赠送余额也渲染', () => {
    const pills = view(bonusOnly);
    assert.deepEqual(pills.map((pill) => pill.text), ['余额 $2.50']);
    assert.match(pills[0].title, /赠送余额 \$2\.50/);
  });
  bonusOnly.disposeAll();

  const amounts = [
    ['5.3671409600000000', '余额 ¥5.36'],
    ['0E-16', '余额 ¥0.00'],
    ['1e+3', '余额 ¥1,000.00'],
    ['1e21', '余额 ¥1,000,000,000,000,000,000,000.00'],
    ['1234567890123456789012', '余额 ¥1,234,567,890,123,456,789,012.00'],
    ['.5', '余额 ¥0.50'],
    ['12.', '余额 ¥12.00'],
    ['1.234e2', '余额 ¥123.40'],
    ['1.234e-2', '余额 ¥0.01'],
    ['0.004', '余额 <¥0.01'],
    ['1e-400', '余额 <¥0.01'],
    ['-0.005', '余额 -¥0.01'],
    ['-12.345', '余额 -¥12.34'],
    ['99.999', '余额 ¥99.99'],
    ['1.005', '余额 ¥1.00'],
    // 前后空白不在 Platform 文法里（zod 会先拒绝），这里选择宽容处理而不是回显原文
    [' 1.0 ', '余额 ¥1.00'],
  ];
  for (const [raw, expected] of amounts) {
    const one = createHarness({ balances: [{ currency: 'CNY', balance: raw }], bonus: [] });
    one.store.subscribe(() => {});
    await settle();
    check(T('金额 ' + raw), () => assert.equal(view(one)[0].text, expected));
    one.disposeAll();
  }

  for (const raw of ['NaN', 'Infinity', '1e999999999', 'abc', '']) {
    const bad = createHarness({ balances: [{ currency: 'CNY', balance: raw }], bonus: [] });
    bad.store.subscribe(() => {});
    await settle();
    check(T('丢弃非法金额 ' + JSON.stringify(raw)), () => {
      assert.deepEqual(view(bad), []);
      assert.equal(bad.logs.filter((line) => line.includes('无法精确表示的余额')).length, 1);
    });
    bad.disposeAll();
  }

  //#region Tooltip 缺失时的降级
  const noTooltip = createHarness({ noTooltip: true });
  noTooltip.store.subscribe(() => {});
  await settle();
  check('缺少 Tooltip 基元时仍渲染按钮', () => {
    const pills = view(noTooltip);
    assert.equal(pills.length, 1);
    assert.equal(pills[0].text, '余额 ¥5.36');
    assert.equal(pills[0].title, null);
    assert.equal(pills[0].aria, '账号余额 ¥5.36');
  });
  noTooltip.disposeAll();
  //#endregion

  console.log(`\n断言：${checks - failures.length}/${checks} 通过`);
  if (failures.length > 0) {
    console.log('\n失败：');
    for (const failure of failures) console.log('  ✗ ' + failure);
    process.exit(1);
  }
  console.log('全部通过。');
})();
