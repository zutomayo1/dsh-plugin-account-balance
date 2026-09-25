/**
 * 只读诊断：状态行没有显示余额时用它确认数据源。
 *
 * 它读取本机 DSH 凭据存储里的平台账号授权，直接向 Platform 发一次
 * GET /api/v0/users/get_user_summary（与 Host 服务同一条路径、同一个请求头），
 * 然后只打印 HTTP 状态与钱包字段——**绝不打印 token、cookie 或响应里的其他字段**。
 *
 * 因为它会从凭据库取出密钥并发起网络请求，必须显式确认：
 *
 *   node tools/probe-balance.mjs --allow-credential-read [dshHome]
 *
 * 正常使用中不需要它：plugin 走的是 Host 的 ctx.deepseekAccount，从不接触凭据。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const allowed = args.includes('--allow-credential-read');
const dshHome = args.find((arg) => !arg.startsWith('--')) ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');

if (!allowed) {
  console.log('本工具会读取本机凭据库中的平台账号授权并发起一次网络请求。');
  console.log('确认后请这样运行：node tools/probe-balance.mjs --allow-credential-read');
  process.exit(2);
}

const credentialsPath = path.join(dshHome, '.credentials.yaml');

let token;
let issuer;
try {
  const lines = fs.readFileSync(credentialsPath, 'utf8').split(/\r?\n/);
  let inAccount = false;
  for (const line of lines) {
    if (/^\s{2}\S/.test(line)) inAccount = line.includes('deepseek-account-platform/default');
    if (!inAccount) continue;
    const secret = line.match(/^\s+token:\s*(\S.*)$/);
    if (secret) token = secret[1].trim().replace(/^["']|["']$/g, '');
    const origin = line.match(/^\s+issuer:\s*(\S.*)$/);
    if (origin) issuer = origin[1].trim().replace(/^["']|["']$/g, '');
  }
} catch (error) {
  console.log('读不到凭据文件：' + credentialsPath + '（' + error.message + '）');
  process.exit(1);
}

if (token === undefined) {
  console.log('凭据里没有平台账号授权（deepseek-account-platform/default）——插件因此不会显示 pill。');
  process.exit(0);
}
console.log('签发来源:', issuer, '| token 长度:', token.length);

const response = await fetch(issuer + '/api/v0/users/get_user_summary', {
  headers: {
    'x-dsh-auth-token': token,
    'x-client-version': '0.1.7-rc.2',
    'x-client-locale': 'zh_CN',
    'x-client-platform': 'web',
  },
});
console.log('HTTP', response.status);
const text = await response.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  console.log('非 JSON 响应:', text.slice(0, 200));
  process.exit(0);
}
console.log('顶层字段:', Object.keys(body).join(', '));
const data = body?.data?.biz_data ?? body?.biz_data ?? body?.data ?? body;
const wallets = (value) => (Array.isArray(value) ? value.map((w) => ({ currency: w.currency, balance: w.balance })) : value);
console.log('normal_wallets:', JSON.stringify(wallets(data?.normal_wallets ?? null)));
console.log('bonus_wallets :', JSON.stringify(wallets(data?.bonus_wallets ?? null)));
if (data?.normal_wallets === undefined) console.log('原始结构样例:', JSON.stringify(body).slice(0, 300));
