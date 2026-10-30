/**
 * 공용 크롬 하나를 띄워두고 모두가 거기에 붙어 쓴다. (2026-10-31 신설)
 *
 * ## 왜
 *
 * 전에는 작업마다 브라우저를 **열고 닫았다.**
 *
 *   - `uploadToNaverCafe()`  : 재업 1건마다 launch → close
 *   - `ensurePosterSession()`: 세션 점검마다 launch → close
 *   - 크롤러 데몬            : 긴 수명이지만 6시간마다 교체, 작업 실패 시에도 교체
 *
 * 그래서 하루에도 수십 번 크롬이 뜨고 죽었다. 문제가 셋이었다.
 *
 *   1) **세션이 깨질 여지가 계속 생긴다.** 로그인 상태 유지가 꺼진 세션이면 닫는 순간
 *      쿠키가 사라진다(2026-10-30에 그렇게 살아있던 세션을 잃었다).
 *   2) **프로필 락 충돌.** 크롬 프로필은 한 프로세스만 열 수 있어서, 수집과 재업이 같은
 *      프로필을 쓰려면 한쪽이 반드시 닫아야 했다. 그 제약 때문에 프로필을 둘로 나눴고,
 *      결국 한 계정이 기기 두 대로 보여 보호조치를 불렀다.
 *   3) **강제 종료 시 탭 복원.** 정상 종료 플래그를 못 남기면 다음 실행에서 이전 탭이
 *      전부 되살아난다(10/2 18개, 10/30 3개, 10/31 29개 — 세 번 반복됐다).
 *
 * 이 PC는 수집·재업 전용이고 화면이 보여도 된다(사용자 확인). 그러면 **로그인된 창
 * 하나를 계속 띄워두고 거기에 붙는 것**이 가장 안정적이다. 쿠키를 옮길 일도, 프로필 락
 * 때문에 닫을 일도, 탭이 복원될 일도 없어진다.
 *
 * ## 규칙
 *
 *   - **브라우저를 닫지 않는다.** 일이 끝나면 **탭만** 닫는다(`releaseSharedPage`).
 *   - 마지막 탭은 닫지 않는다 — 닫으면 크롬이 함께 종료된다.
 *   - 데몬이 끝날 때는 `close()`가 아니라 `disconnect()` — 크롬은 계속 살아 있어야 한다.
 *   - 이미 떠 있는 크롬은 프로필 폴더의 `DevToolsActivePort`를 읽어 붙는다.
 *     (사람이 `manual-login.js`로 로그인해 둔 그 창에 그대로 붙는다)
 */

import puppeteer, { type Browser, type Page } from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { shouldRunHeadless } from './stealth';

/** 탭이 무한정 쌓이지 않게 하는 상한 */
const MAX_TABS = 4;

/** 크롬이 디버깅 포트를 열 때까지 기다리는 한도 */
const SPAWN_WAIT_MS = 40_000;

let shared: Browser | null = null;

function profileDir(): string | undefined {
  return process.env.NAVER_PROFILE_DIR || undefined;
}

function isAlive(b: Browser | null): b is Browser {
  if (!b) return false;
  const anyB = b as unknown as { connected?: boolean; isConnected?: () => boolean };
  if (typeof anyB.connected === 'boolean') return anyB.connected;
  if (typeof anyB.isConnected === 'function') return anyB.isConnected();
  return false;
}

/**
 * 프로필 폴더의 `DevToolsActivePort`로 웹소켓 주소를 만든다.
 * 파일 형식은 두 줄 — 1행 포트, 2행 브라우저 경로(`/devtools/browser/<id>`).
 */
function readDevToolsEndpoint(dir: string): string | null {
  try {
    const f = path.join(dir, 'DevToolsActivePort');
    if (!fs.existsSync(f)) return null;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const port = Number((lines[0] || '').trim());
    const wsPath = (lines[1] || '').trim();
    if (!port || !wsPath) return null;
    return `ws://127.0.0.1:${port}${wsPath}`;
  } catch {
    return null;
  }
}

/** 떠 있는 크롬에 붙어본다. 없거나 죽었으면 null */
async function tryConnect(): Promise<Browser | null> {
  const dir = profileDir();
  if (!dir) return null;
  const endpoint = readDevToolsEndpoint(dir);
  if (!endpoint) return null;
  try {
    const b = await puppeteer.connect({
      browserWSEndpoint: endpoint,
      protocolTimeout: 300_000,
      defaultViewport: null,
    });
    await b.version(); // 실제로 응답하는지 확인 (잔재 파일일 수 있다)
    console.log('[SharedBrowser] 떠 있는 크롬에 붙었습니다 —', endpoint.replace(/\/devtools.*/, ''));
    return b;
  } catch {
    return null;
  }
}

/**
 * 공용 브라우저를 돌려준다. 떠 있으면 붙고, 없으면 새로 띄운다.
 * 띄운 경우에도 **닫지 않는다** — 다음 호출이 그 창에 다시 붙는다.
 */
export async function getSharedBrowser(): Promise<Browser> {
  if (isAlive(shared)) return shared;
  shared = null;

  const connected = await tryConnect();
  if (connected) {
    shared = connected;
    return shared;
  }

  await spawnDetachedChrome();

  const after = await tryConnect();
  if (!after) {
    throw new Error('공용 크롬을 띄웠지만 붙지 못했습니다 (DevToolsActivePort 확인 실패)');
  }
  shared = after;

  // 연결이 끊겨도 크롬은 살아 있다. 캐시만 비우고 다음 호출에서 다시 붙는다.
  shared.on('disconnected', () => {
    console.warn('[SharedBrowser] 크롬 연결이 끊겼습니다 — 다음 호출에서 다시 붙습니다.');
    shared = null;
  });

  return shared;
}

/**
 * 크롬을 **분리 실행(detached)** 한다.
 *
 * `puppeteer.launch()`로 띄우면 크롬이 그 노드 프로세스의 자식이 되어, 데몬이나 로그인
 * 스크립트가 끝나는 순간 **크롬도 함께 죽는다**(2026-10-31에 실제로 그래서 로그인 창이
 * 남지 않았다). 그래서 직접 spawn 하고 부모와의 연결을 끊는다.
 *
 * 이렇게 하면 데몬을 재시작해도, 로그인 스크립트를 닫아도 **로그인된 창은 계속 떠 있다.**
 */
async function spawnDetachedChrome(): Promise<void> {
  const dir = profileDir();
  if (!dir) throw new Error('NAVER_PROFILE_DIR 가 없습니다 — 공용 크롬을 띄울 프로필을 알 수 없습니다.');

  // 지난 실행의 잔재 포트 파일이 있으면 지운다 (옛 포트에 붙으려다 실패하는 것을 막는다)
  const portFile = path.join(dir, 'DevToolsActivePort');
  try {
    if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
  } catch {
    /* 지우지 못해도 아래에서 새 파일을 기다린다 */
  }

  // 버전에 따라 string 또는 Promise<string> 을 돌려준다 — 양쪽 다 받는다
  const exe: string = await Promise.resolve(puppeteer.executablePath());
  const args = [
    `--user-data-dir=${dir}`,
    // 포트는 0으로 두고 크롬이 고른 값을 DevToolsActivePort 에서 읽는다.
    // 고정 포트는 이미 점유돼 있으면 조용히 실패한다.
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-blink-features=AutomationControlled',
    '--lang=ko-KR',
    '--window-size=1280,1024',
    'about:blank',
  ];
  if (shouldRunHeadless()) args.push('--headless=new');

  console.log('[SharedBrowser] 붙을 크롬이 없습니다 — 분리 실행으로 띄웁니다 (프로필:', dir, ')');
  const child: ChildProcess = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref(); // 부모가 끝나도 크롬은 계속 돈다

  // 디버깅 포트가 열릴 때까지 기다린다
  const deadline = Date.now() + SPAWN_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (readDevToolsEndpoint(dir)) return;
  }
  throw new Error(`크롬이 ${SPAWN_WAIT_MS / 1000}초 안에 디버깅 포트를 열지 않았습니다.`);
}

/** 쌓인 빈 탭을 정리한다 (브라우저는 건드리지 않는다) */
async function pruneTabs(browser: Browser, keep: Page): Promise<void> {
  try {
    const pages = await browser.pages();
    if (pages.length <= MAX_TABS) return;
    for (const p of pages) {
      if (p === keep) continue;
      const url = p.url();
      // 빈 탭과 네이버 탭만 정리한다. 사람이 열어둔 다른 탭은 건드리지 않는다.
      if (url === 'about:blank' || url === '' || /(^https?:\/\/)([^/]*\.)?naver\.com/.test(url)) {
        await p.close().catch(() => {});
      }
      const left = await browser.pages();
      if (left.length <= MAX_TABS) break;
    }
  } catch {
    /* 정리 실패는 본작업을 막지 않는다 */
  }
}

/** 공용 브라우저에 새 탭을 연다 */
export async function newSharedPage(): Promise<Page> {
  const browser = await getSharedBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);
  await pruneTabs(browser, page);
  return page;
}

/**
 * 일이 끝난 탭을 닫는다. **브라우저는 닫지 않는다.**
 * 마지막 탭이면 닫는 대신 빈 페이지로 돌려놓는다 — 마지막 탭을 닫으면 크롬이 종료된다.
 */
export async function releaseSharedPage(page: Page | null): Promise<void> {
  if (!page) return;
  try {
    const browser = page.browser();
    const pages = await browser.pages();
    if (pages.length <= 1) {
      await page.goto('about:blank').catch(() => {});
      return;
    }
    if (!page.isClosed()) await page.close();
  } catch {
    /* 이미 닫혔거나 연결이 끊겼다 */
  }
}

/**
 * 연결만 끊는다. 크롬은 계속 살아 있어야 하므로 `close()`를 쓰지 않는다.
 * (데몬을 재시작해도 로그인된 창에 그대로 다시 붙는다)
 */
export async function disconnectSharedBrowser(): Promise<void> {
  if (!isAlive(shared)) {
    shared = null;
    return;
  }
  try {
    await shared.disconnect();
    console.log('[SharedBrowser] 연결만 끊었습니다 (크롬은 계속 떠 있습니다).');
  } catch {
    /* 무시 */
  }
  shared = null;
}

/** 지금 공용 브라우저에 붙어 있는지 (진단용) */
export function isSharedBrowserConnected(): boolean {
  return isAlive(shared);
}
