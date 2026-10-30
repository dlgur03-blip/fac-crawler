/**
 * 공용 크롬을 "붙거나, 없으면 분리 실행으로 띄운다". (2026-10-31 신설)
 *
 * `src/lib/naver/shared-browser.ts` 와 **같은 규칙을 JS로 옮긴 것**이다.
 * (manual-login.js 등은 node로 직접 돌아 TS 모듈을 import할 수 없다.
 *  한쪽을 고치면 다른 쪽도 고쳐야 한다 — stealth/humanType 과 같은 사정)
 *
 * ## 왜 분리 실행인가
 *
 * `puppeteer.launch()`로 띄우면 크롬이 그 노드 프로세스의 **자식**이 된다. 그래서 로그인
 * 스크립트가 끝나거나 데몬이 재시작되면 **크롬도 같이 죽는다.** 2026-10-31에 로그인 창을
 * 띄워두려 했는데 스크립트 종료와 함께 사라졌다(크롬 프로세스 0개).
 *
 * 직접 spawn 하고 부모와의 연결을 끊으면(`detached` + `unref`), 로그인된 창이 계속 떠 있고
 * 데몬은 거기에 붙기만 하면 된다. 쿠키를 옮길 필요도, 프로필 락 때문에 닫을 필요도 없다.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SPAWN_WAIT_MS = 40_000;

/** 프로필 폴더의 DevToolsActivePort 를 읽어 웹소켓 주소를 만든다 */
function readDevToolsEndpoint(profileDir) {
  try {
    const f = path.join(profileDir, 'DevToolsActivePort');
    if (!fs.existsSync(f)) return null;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const port = Number((lines[0] || '').trim());
    const wsPath = (lines[1] || '').trim();
    if (!port || !wsPath) return null;
    return 'ws://127.0.0.1:' + port + wsPath;
  } catch {
    return null;
  }
}

/** 떠 있는 크롬에 붙어본다. 없거나 응답이 없으면 null */
async function tryConnect(puppeteer, profileDir) {
  const endpoint = readDevToolsEndpoint(profileDir);
  if (!endpoint) return null;
  try {
    const browser = await puppeteer.connect({
      browserWSEndpoint: endpoint,
      protocolTimeout: 300_000,
      defaultViewport: null,
    });
    await browser.version(); // 잔재 파일이 아니라 실제로 살아있는지 확인
    return browser;
  } catch {
    return null;
  }
}

/** 크롬을 분리 실행한다 (부모가 죽어도 살아남는다) */
async function spawnDetached(puppeteer, profileDir, { headless = false } = {}) {
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  try {
    if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
  } catch {
    /* 못 지워도 아래에서 새 파일을 기다린다 */
  }

  // 버전에 따라 string 또는 Promise<string> 을 돌려준다 — 양쪽 다 받는다
  // (2026-10-31: await 없이 넘겨 `file 인자는 string 이어야 한다`로 실패했다)
  const exe = await Promise.resolve(puppeteer.executablePath());
  const args = [
    '--user-data-dir=' + profileDir,
    // 고정 포트는 이미 점유돼 있으면 조용히 실패한다 → 0으로 두고 크롬이 고른 값을 읽는다
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-blink-features=AutomationControlled',
    '--lang=ko-KR',
    '--window-size=1150,950',
    '--window-position=100,50',
    'about:blank',
  ];
  if (headless) args.push('--headless=new');

  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();

  const deadline = Date.now() + SPAWN_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (readDevToolsEndpoint(profileDir)) return;
  }
  throw new Error('크롬이 ' + SPAWN_WAIT_MS / 1000 + '초 안에 디버깅 포트를 열지 않았습니다.');
}

/**
 * 공용 크롬을 돌려준다.
 * @returns {{ browser: import('puppeteer').Browser, spawned: boolean, endpoint: string }}
 */
async function ensureBrowser(puppeteer, profileDir, opts = {}) {
  let browser = await tryConnect(puppeteer, profileDir);
  if (browser) {
    return { browser, spawned: false, endpoint: readDevToolsEndpoint(profileDir) };
  }
  await spawnDetached(puppeteer, profileDir, opts);
  browser = await tryConnect(puppeteer, profileDir);
  if (!browser) throw new Error('크롬을 띄웠지만 붙지 못했습니다 (DevToolsActivePort 확인 실패)');
  return { browser, spawned: true, endpoint: readDevToolsEndpoint(profileDir) };
}

module.exports = { ensureBrowser, tryConnect, readDevToolsEndpoint };
