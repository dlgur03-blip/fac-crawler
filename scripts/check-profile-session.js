/**
 * 프로필에 네이버 세션이 실제로 살아 있는지 확인한다 (2026-10-02 신설).
 *
 * 왜 필요한가: 2026-08에 데몬이 프로필을 잡고 있는 상태로 프로필을 복사했더니 쿠키가
 * 디스크에 flush되지 않아 **쿠키 없는 복사본**이 만들어졌고, 전건 401이 나면서 멀쩡한 글
 * 248건을 삭제로 오분류할 뻔했다. 복사·이관 뒤에는 반드시 실제로 열어서 확인한다.
 *
 * 판정은 화면 글자가 아니라 세션 쿠키(NID_AUT·NID_SES)로 한다.
 *
 * 사용법:
 *   node scripts/check-profile-session.js crawler
 *   node scripts/check-profile-session.js poster
 *
 * ⚠️ 해당 데몬이 멈춰 있어야 한다. 크롬 프로필은 한 번에 한 프로세스만 쓸 수 있다.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIRS = { crawler: '.naver_profile', poster: '.naver_profile_poster' };

const which = process.argv[2] || 'crawler';
const rel = DIRS[which];
if (!rel) {
  console.error('사용법: node scripts/check-profile-session.js [crawler|poster]');
  process.exit(1);
}
const profileDir = path.join(ROOT, rel);

// console.log을 쓴다 — process.stdout.write + 이른 종료 조합에서 윈도우는 출력을 통째로
// 잃어버린다(실제로 아무것도 안 찍히고 종료코드만 남았다).
const log = (s) => console.log(s);

// 다른 프로세스의 잔재가 남아 있으면 기동이 막힐 수 있다 — 지우지 않고 알리기만 한다.
// (파일 삭제는 환경에 따라 막히므로 점검 도구가 삭제까지 하지는 않는다)
const leftovers = ['DevToolsActivePort', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']
  .filter((f) => fs.existsSync(path.join(profileDir, f)));
if (leftovers.length) log('잔재 파일 있음(무시 가능): ' + leftovers.join(', '));

(async () => {
  const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer'));

  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: profileDir,
    protocolTimeout: 120_000,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--lang=ko-KR',
      '--hide-crash-restore-bubble',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const page = (await browser.pages())[0] || (await browser.newPage());
  page.setDefaultTimeout(60_000);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  await page.goto('https://www.naver.com', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const names = (await page.cookies('https://naver.com')).map((c) => c.name);
  const ok = names.includes('NID_AUT') && names.includes('NID_SES');

  log('');
  log('■ ' + which + ' 프로필 (' + rel + ')');
  log('  NID_AUT: ' + names.includes('NID_AUT') + '   NID_SES: ' + names.includes('NID_SES'));
  log('  → ' + (ok ? '로그인 상태' : '세션 없음'));

  if (ok) {
    // 카페까지 실제로 들어가 본다 — 쿠키만으로는 등급/권한을 알 수 없다.
    // PC판(cafe.naver.com/f-e)은 SPA라 domcontentloaded 시점에 본문이 비어 있다.
    // 모바일판이 서버에서 글 목록을 채워 내려주므로 판정이 확실하다.
    await page.goto('https://m.cafe.naver.com/ca-fe/web/cafes/28310071', { waitUntil: 'networkidle2', timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 3500));
    const seen = await page.evaluate(() => {
      const text = document.body.innerText;
      const nick = text.match(/핫딜매니저\d*/);
      return {
        nick: nick ? nick[0] : null,
        joinPrompt: /카페 가입하기/.test(text),
        head: text.replace(/\s+/g, ' ').slice(0, 120),
      };
    });
    log('  카페 닉네임: ' + (seen.nick || '(못읽음)'));
    log('  가입 안내 노출: ' + (seen.joinPrompt ? '예 (미가입 의심)' : '아니오'));
    log('  화면: ' + seen.head);
  }

  await browser.close();
  log('');
  log('브라우저 정상 종료');
  // process.exit()을 쓰지 않는다 — 윈도우에서 stdout이 파이프면 쓰기가 비동기라,
  // 즉시 종료하면 버퍼에 남은 출력이 통째로 사라진다(실제로 아무것도 안 찍혔다).
  process.exitCode = ok ? 0 : 2;
})().catch((e) => {
  log('실패: ' + e.message);
  process.exitCode = 1;
});
