/**
 * 네이버 수동 로그인 도우미 (2026-10-02)
 *
 * 배경: 카페 계정 비밀번호가 바뀌면서 네이버가 두 크롬 프로필의 세션을 모두 끊었다.
 * 데몬이 재로그인을 시도했으나 캡차/기기확인에 막혀 10분마다 비밀번호를 제출했고
 * (18시간에 122회, 계정 잠김 위험) 결국 데몬을 멈추고 사람이 한 번 통과시키기로 했다.
 *
 * 이 스크립트는 운영 프로필을 그대로 열어 아이디만 사람처럼 타이핑해 둔다.
 * 비밀번호와 캡차는 사람이 직접 처리한다(캡차는 자동으로 풀면 안 되고, 풀 수도 없다).
 * 통과하면 세션이 프로필 디스크에 저장되고 데몬은 다시 헤드리스로 돌 수 있다.
 *
 * === 자동화 흔적 줄이기 ===
 * 네이버 로그인은 브라우저가 자동화인지 꽤 본다. 아래를 맞춰준다.
 *
 *  1) `--enable-automation` 제거 — puppeteer가 기본으로 붙이는 플래그다. 이게 붙으면
 *     navigator.webdriver === true 가 되고 "자동화 소프트웨어가 제어 중" 띠까지 뜬다.
 *     자동화라고 자백하는 신호라 ignoreDefaultArgs 로 뺀다.
 *  2) UA를 건드리지 않는다 — 데몬 본체(naver-crawler-daemon.ts:207)는 UA를 '맥 크롬 120'
 *     으로 바꿔 보내는데, 실제는 윈도우 크롬 149다. 플랫폼·폰트·WebGL은 전부 윈도우라고
 *     말하므로 이 조합이 평범한 브라우저보다 오히려 더 눈에 띈다. 진짜 UA를 그대로 쓴다.
 *  3) navigator.webdriver / languages / plugins 를 평범한 값으로 덮는다.
 *  4) 타이핑은 사람처럼 — 글자마다 지연을 흔들어 준다.
 *
 * ⚠️ 시스템 크롬(v153)을 쓰면 안 된다. 프로필이 153으로 업그레이드되면
 *    Chrome for Testing 149로 도는 데몬이 그 프로필을 영영 못 연다.
 *    반드시 puppeteer 번들 크롬(데몬과 같은 것)으로 연다.
 *
 * 사용법:
 *   node scripts/manual-login.js poster     # .naver_profile_poster  (재업기)
 *   node scripts/manual-login.js crawler    # .naver_profile         (수집기)
 *
 * ⚠️ 해당 데몬을 먼저 멈춰야 한다. 크롬 프로필은 한 번에 한 프로세스만 쓸 수 있다.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const TARGETS = {
  poster: { profile: '.naver_profile_poster', idKey: 'NAVER_POSTER_USER_ID', pwKey: 'NAVER_POSTER_PW', label: '재업기' },
  crawler: { profile: '.naver_profile', idKey: 'NAVER_USER_ID', pwKey: 'NAVER_USER_PW', label: '수집기' },
};

const which = process.argv[2];
const target = TARGETS[which];
if (!target) {
  console.error('사용법: node scripts/manual-login.js [poster|crawler]');
  process.exit(1);
}

const env = {};
fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/).forEach((line) => {
  const i = line.indexOf('=');
  if (i > 0 && !line.startsWith('#')) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
});

const ID = env[target.idKey];
if (!ID) {
  console.error(`.env.local에 ${target.idKey} 가 없습니다.`);
  process.exit(1);
}

// 비밀번호도 사람처럼 입력한다. 없으면 칸을 비워 두고 사람이 치게 한다.
// `--no-pw` 를 주면 환경변수가 있어도 비워 둔다 (손으로 치고 싶을 때).
const PW = process.argv.includes('--no-pw') ? '' : env[target.pwKey] || '';

const profileDir = path.join(ROOT, target.profile);
const log = (s) => process.stdout.write(s + '\n');

/** 로그인 판정은 화면 글자가 아니라 세션 쿠키로 한다 */
async function isLoggedIn(page) {
  const names = (await page.cookies('https://naver.com')).map((c) => c.name);
  return names.includes('NID_AUT') && names.includes('NID_SES');
}

/**
 * 로그인 폼 옵션을 데몬 용도에 맞춘다. (2026-10-30)
 *
 * 기본값이 우리 용도와 반대다 — 이게 세션이 자꾸 끊기던 원인이었다.
 *   #loginStay(로그인 상태 유지) 기본 꺼짐 → 켠다 (세션을 길게)
 *   #switchIP(IP 보안)          기본 켜짐 → 끈다 (IP 바뀌어도 세션 유지)
 *
 * 세션이 끊길 때마다 재로그인하게 되고, 그 반복이 네이버에겐 도용 시도로 보여
 * 기기확인 → 보호조치로 이어졌다.
 *
 * ⚠️ 같은 규칙이 src/lib/naver/uploader.ts 의 applyLoginOptions 에도 있다.
 *    한쪽만 고치면 데몬과 수동 로그인이 서로 다른 세션 수명을 갖게 된다 — 같이 고칠 것.
 */
async function applyLoginOptions(page) {
  try {
    const read = () =>
      page.evaluate(() => ({
        stay: document.querySelector('#loginStay')?.checked ?? null,
        ip: document.querySelector('#switchIP')?.checked ?? null,
      }));

    const before = await read();
    if (before.stay === false) {
      if (!(await humanClick(page, 'label[for="loginStay"]'))) {
        await page.click('label[for="loginStay"]').catch(() => page.click('#loginStay'));
      }
      await new Promise((r) => setTimeout(r, 250 + Math.floor(Math.random() * 350)));
    }
    if (before.ip === true) {
      if (!(await humanClick(page, '#switchIP'))) {
        await page.click('#switchIP').catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 250 + Math.floor(Math.random() * 350)));
    }
    const after = await read();
    log(`로그인 옵션 — 상태유지 ${before.stay}→${after.stay} / IP보안 ${before.ip}→${after.ip}`);
  } catch (e) {
    log('로그인 옵션 설정 실패(계속 진행): ' + e.message);
  }
}

/**
 * 사람 입력 흉내 — fac/src/lib/naver/stealth.ts 와 같은 규칙을 JS로 옮긴 것.
 * (이 파일은 node로 직접 돌아 TS 모듈을 import할 수 없어 중복 구현한다.
 *  한쪽을 고치면 다른 쪽도 고쳐야 한다 — 2026-10-30 양쪽 동시 개편)
 *
 * 예전 구현은 글자 간격만 균등분포로 흔들었다. 사람과 다른 점이 넷 남아 있었다.
 *   a) 커서가 순간이동했다 (page.click은 좌표로 바로 놓고 누른다)
 *   b) 항상 요소의 정중앙을 찍었다
 *   c) 간격이 균등분포였다 (사람은 종 모양 + 시프트에서 느려짐 + 중간에 멈춤)
 *   d) 키를 누르고 있는 시간이 없었다
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.round(ms))));
const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));

/** 정규분포 근사 — 사람의 간격은 평균 주변에 몰린 종 모양이다 */
function gauss(mean, sd, min, max) {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.min(max, Math.max(min, mean + z * sd));
}

let cursor = { x: rand(120, 700), y: rand(120, 540) };

/** 궤적을 그리며 이동한다. 멀면 살짝 지나쳤다가 되돌아온다 */
async function moveTo(page, x, y) {
  const dist = Math.hypot(x - cursor.x, y - cursor.y);

  if (dist > 40) {
    const t = rand(0.35, 0.65);
    const sway = Math.min(60, dist * 0.12);
    await page.mouse.move(
      cursor.x + (x - cursor.x) * t + rand(-sway, sway),
      cursor.y + (y - cursor.y) * t + rand(-sway, sway),
      { steps: Math.max(4, Math.round(dist / 26)) }
    );
    await sleep(gauss(28, 12, 8, 70));
  }

  if (dist > 160) {
    await page.mouse.move(x + rand(-13, 13), y + rand(-9, 9), {
      steps: Math.max(6, Math.round(dist / 18)),
    });
    await sleep(gauss(52, 20, 18, 120));
    await page.mouse.move(x, y, { steps: randInt(3, 7) });
  } else {
    await page.mouse.move(x, y, { steps: Math.max(5, Math.round(dist / 9)) });
  }
  cursor = { x, y };
}

/** 요소 안쪽 임의 지점을 사람처럼 누른다 */
async function humanClick(page, selector) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, selector);
  if (!box) return false;

  await moveTo(page, box.x + box.w * rand(0.2, 0.8), box.y + box.h * rand(0.25, 0.75));
  await sleep(gauss(95, 45, 30, 280));
  await page.mouse.down();
  await sleep(gauss(68, 24, 32, 165));
  await page.mouse.up();
  return true;
}

/** Ctrl+A → Backspace 로 비운다 (JS value='' 는 지운 흔적을 남기지 않는다) */
async function humanClearField(page, selector) {
  const need = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return !!el && el.value.length > 0;
  }, selector);
  if (!need) return;

  if (!(await humanClick(page, selector))) await page.focus(selector).catch(() => {});
  await sleep(gauss(140, 50, 60, 320));
  await page.keyboard.down('Control');
  await sleep(gauss(45, 15, 20, 90));
  await page.keyboard.press('KeyA', { delay: Math.round(gauss(60, 20, 30, 120)) });
  await sleep(gauss(40, 15, 15, 85));
  await page.keyboard.up('Control');
  await sleep(gauss(120, 45, 50, 280));
  await page.keyboard.press('Backspace', { delay: Math.round(gauss(65, 20, 35, 130)) });
  await sleep(gauss(150, 60, 60, 350));
}

const SHIFTED = /[A-Z!@#$%^&*()_+{}|:"<>?~]/;

/**
 * 사람처럼 치고 **되읽어 검증**한다.
 * 붙여넣기는 쓰지 않는다 — 전부 실제 키 입력이다.
 * @returns 길이가 기대와 같으면 true (값은 어디에도 기록하지 않는다)
 */
async function humanType(page, selector, text) {
  if (!(await humanClick(page, selector))) await page.focus(selector).catch(() => {});
  await sleep(gauss(280, 110, 90, 650));

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    await page.keyboard.type(ch, { delay: Math.round(gauss(62, 19, 28, 125)) });
    let gap = gauss(108, 40, 42, 270);
    if (SHIFTED.test(ch)) gap += gauss(62, 26, 18, 160);
    if (i > 1 && Math.random() < 0.07) gap += gauss(330, 150, 110, 820);
    await sleep(gap);
  }

  const len = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.value.length : -1;
  }, selector);
  if (len !== text.length) {
    log(`⚠ 입력 검증 실패 ${selector} — 기대 ${text.length}자, 실제 ${len}자`);
    return false;
  }
  return true;
}

(async () => {
  const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer'));

  log(`■ ${target.label} 로그인 — 프로필 ${target.profile}`);
  log(`  아이디 ${ID}`);
  log(`  프로필 존재: ${fs.existsSync(profileDir) ? '예' : '아니오 (새로 만듭니다)'}\n`);

  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: profileDir,
    defaultViewport: null,
    // 데몬이 강제 종료되면 크롬이 정상 종료 플래그를 못 남겨 다음 실행에서 **이전 탭을
    // 전부 복원**한다. 2026-10-02에 18개가 되살아나 CDP 호출이 타임아웃으로 죽었고,
    // 2026-10-30에 같은 자리에서 또 막혔다. 넉넉히 주고, 아래에서 탭을 정리한다.
    protocolTimeout: 300_000,
    // 자동화 자백 플래그 제거
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--lang=ko-KR',
      '--window-size=1150,950',
      '--window-position=100,50',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-crash-restore-bubble',
    ],
  });

  // 복원된 탭 정리 — 하나만 남긴다. 탭이 많으면 CDP가 느려져 아래 호출들이 타임아웃난다.
  {
    const opened = await browser.pages();
    if (opened.length > 1) {
      log(`복원된 탭 ${opened.length}개 — 1개만 남기고 닫습니다`);
      for (const p of opened.slice(1)) {
        try { await p.close(); } catch { /* 이미 닫힘 */ }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const page = (await browser.pages())[0] || (await browser.newPage());
  page.setDefaultTimeout(60_000);

  // 평범한 브라우저처럼 보이게 — 페이지마다 문서 생성 시점에 적용
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    if (!window.chrome) window.chrome = { runtime: {} };
  });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' });

  // 진짜 UA 확인 — 데몬처럼 가짜로 덮지 않는다
  const ua = await browser.userAgent();
  log('UA(실제 그대로 사용): ' + ua.slice(0, 95));

  await page.goto('https://www.naver.com', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (await isLoggedIn(page)) {
    log('✅ 이미 로그인되어 있습니다. 아무것도 하지 않고 닫습니다.');
    await browser.close();
    return;
  }

  // 이전 계정 흔적 제거 후 깨끗한 로그인 페이지
  await page.goto('https://nid.naver.com/nidlogin.logout', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
  await page.goto('https://nid.naver.com/nidlogin.login', { waitUntil: 'networkidle2', timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 1500));

  const wd = await page.evaluate(() => String(navigator.webdriver));
  log('navigator.webdriver: ' + wd + (wd === 'undefined' ? '  ← 자동화 흔적 없음' : '  ⚠ 아직 노출됨'));

  await humanClearField(page, '#id');
  await humanClearField(page, '#pw');

  const idOk = await humanType(page, '#id', ID);
  await applyLoginOptions(page);

  // 비밀번호도 채운다. 단 **로그인 버튼은 누르지 않는다** — 캡차·기기확인이 있는 상태에서
  // 자동 제출은 실패 1회로 집계되고, 실패 누적이 곧 계정 보호조치다.
  // 사람이 화면을 보고 누르는 것이 가장 안전하다.
  let pwOk = false;
  if (PW) {
    pwOk = await humanType(page, '#pw', PW);
    if (!pwOk) {
      // 온전히 안 들어갔으면 지워 둔다. 반쪽 값으로 제출되면 실패 1회가 된다.
      await humanClearField(page, '#pw');
      log('⚠ 비밀번호가 온전히 입력되지 않아 칸을 비웠습니다 — 직접 입력해 주세요.');
    }
  }

  if (!(await humanClick(page, '#pw'))) await page.focus('#pw').catch(() => {});

  log('');
  log(`아이디 입력 ${idOk ? '완료' : '실패'} / 비밀번호 ${PW ? (pwOk ? '완료' : '실패 — 직접 입력') : '비움 (환경변수 없음)'}`);
  log('복붙이 아니라 실제 키 입력이고, 글자 간격·키 누름 시간·클릭 지점을 매번 다르게 했습니다.');
  log('→ 창에서 [로그인]을 눌러주세요. 캡차나 기기확인이 나오면 통과해 주세요.');
  log('   (버튼은 일부러 누르지 않습니다. 실패가 쌓이면 계정에 보호조치가 걸립니다)');
  log('   (최대 15분 기다립니다)\n');

  const deadline = Date.now() + 15 * 60_000;
  let ok = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    try { if (await isLoggedIn(page)) { ok = true; break; } } catch { /* 이동 중 */ }
  }

  if (!ok) {
    log('⏰ 15분 안에 로그인이 확인되지 않았습니다. 창은 열어둡니다 — 끝내고 직접 닫아주세요.');
    try {
      log('화면: ' + (await page.evaluate(() => document.body.innerText.replace(/\n+/g, ' | ').slice(0, 300))));
    } catch { /* 무시 */ }
    browser.disconnect();
    return;
  }

  log('✅ 로그인 성공 (NID_AUT·NID_SES 발급 확인)');

  // 카페 본문을 읽을 수 있는 등급인지 — 못 읽으면 수집이 조용히 빠진다
  try {
    await page.goto('https://m.cafe.naver.com/ca-fe/web/cafes/28310071', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 2500));
    const cafe = await page.evaluate(async () => {
      const res = await fetch(
        'https://apis.naver.com/cafe-web/cafe-articleapi/v3/cafes/28310071/articles/427165?query=&useCafeId=true',
        { credentials: 'include' }
      );
      const json = await res.json();
      return { status: res.status, subject: json?.result?.article?.subject ?? null };
    });
    log(
      cafe.subject
        ? `✅ 카페 본문 읽기 성공 — "${String(cafe.subject).slice(0, 45)}"`
        : `⚠️ 카페 본문 읽기 실패 (HTTP ${cafe.status}) — 계정 등급 확인 필요`
    );
  } catch (e) {
    log('⚠️ 카페 확인 중 오류: ' + e.message);
  }

  await new Promise((r) => setTimeout(r, 1500));
  await browser.close();
  log('\n세션이 프로필에 저장됐습니다. 데몬을 다시 켜도 됩니다.');
})().catch((e) => {
  log('실패: ' + e.message);
  if (/profile|ProcessSingleton|in use/i.test(e.message)) {
    log('→ 해당 데몬이 아직 살아 있습니다. 먼저 종료하세요.');
  }
  process.exit(1);
});
