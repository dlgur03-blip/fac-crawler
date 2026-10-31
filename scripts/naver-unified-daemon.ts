/**
 * 통합 데몬 — 수집과 재업을 **한 프로세스·한 프로필·한 계정**으로 번갈아 돌린다.
 * (2026-10-30 신설)
 *
 * ## 왜 합쳤나
 *
 * 전에는 데몬이 둘이었고, 각자 크롬 프로필을 갖고 **같은 계정으로 따로 로그인**했다.
 *
 *     수집기 → .naver_profile          (각자 로그인 → 각자의 세션 토큰)
 *     재업기 → .naver_profile_poster   (각자 로그인 → 각자의 세션 토큰)
 *     사람   → 휴대폰                   (같은 계정을 이동통신에서)
 *
 * 네이버 입장에서는 한 아이디가 서로 다른 장소에서 동시에 접속하는 모양이다. 이건 계정
 * 도용 탐지의 전형적인 신호이고, 2026-10-30 하루에 보호조치가 **두 번** 걸렸다.
 * (한 번은 세션 쿠키를 프로필 사이로 복사해 같은 토큰을 두 브라우저가 쓴 것이 원인)
 *
 * 로그인 횟수도 두 배였다. 복구할 때도 두 번 로그인해야 했다.
 *
 * ## 설계
 *
 *     수집 한 바퀴 → 브라우저 닫기(프로필 락 해제) → 재업 한 바퀴 → 반복
 *
 * - **프로필 하나**(`.naver_profile`). 크롬 프로필은 두 프로세스가 동시에 열 수 없으므로,
 *   수집이 끝나면 `releaseCrawlBrowser()`로 반드시 닫고 재업 차례를 준다.
 * - **계정 하나**. 재업기 모듈은 `NAVER_POSTER_USER_ID`가 있으면 그것으로 덮어쓰므로,
 *   여기서 미리 수집 계정과 같게 맞춰 "어느 쪽이 쓰이는지" 모호함을 없앤다.
 * - **동시 실행 없음**. 두 tick을 순차로 await 한다. 겹칠 수 없다.
 * - 세션 쿠키는 디스크에 영구 저장된다(`applyLoginOptions`의 로그인 상태 유지 ON).
 *   그래서 브라우저를 닫아도 로그인이 유지되고, 이 교대가 성립한다.
 *   상태유지가 꺼진 세션이라면 닫는 순간 로그아웃되므로 이 구조가 성립하지 않는다.
 *
 * ## 기존 데몬은 그대로 둔다
 *
 * `naver-crawler-daemon.ts` / `naver-poster-daemon.ts`는 단독 실행도 계속 된다.
 * 이 파일이 import 할 때만 `NAVER_DAEMON_MODE=unified`로 자체 루프를 끈다.
 * 문제가 생기면 통합을 끄고 예전처럼 둘로 되돌릴 수 있다.
 *
 * ## 실행
 *
 *     npx tsx scripts/naver-unified-daemon.ts
 *
 * ⚠️ 기존 두 데몬(작업 스케줄러 FACTORIES-CrawlerDaemon / FACTORIES-PosterDaemon)을
 *    **반드시 먼저 멈춰야 한다.** 같이 돌면 합친 의미가 없고 프로필 락도 충돌한다.
 */

import fs from 'fs';
import path from 'path';

// ---- .env.local 로드 (dotenv 없이 간단 파싱 — 기존 두 데몬과 동일한 방식) ----
(function loadEnv() {
  const p = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
})();

// ── 1) 하위 모듈이 자체 루프를 돌리지 않게 한다 (import 전에 설정해야 한다) ──
process.env.NAVER_DAEMON_MODE = 'unified';

// ── 2) 프로필 하나로 통일 ──
// 수집기는 NAVER_PROFILE_DIR, 재업기는 NAVER_POSTER_PROFILE_DIR 을 본다.
// 둘을 같은 경로로 맞춘다. (재업기 모듈이 NAVER_PROFILE_DIR 을 덮어쓰지만,
//  NAVER_POSTER_PROFILE_DIR 이 있으면 그 값을 쓰므로 결과가 같다)
const PROFILE = process.env.NAVER_PROFILE_DIR || path.join(process.cwd(), '.naver_profile');
process.env.NAVER_PROFILE_DIR = PROFILE;
process.env.NAVER_POSTER_PROFILE_DIR = PROFILE;

// ── 3) 계정 하나로 통일 ──
// 자동화는 한 계정만 쓴다(사용자 결정 2026-10-30: 다른 계정은 휴대폰에서 사람이 쓴다).
// 재업기 모듈은 NAVER_POSTER_USER_ID/PW 가 있으면 NAVER_USER_ID/PW 를 덮어쓴다.
// 그래서 여기서 둘을 같게 맞춘다 — 어느 쪽 값이 쓰이든 같은 계정이 된다.
if (process.env.NAVER_USER_ID && process.env.NAVER_USER_PW) {
  process.env.NAVER_POSTER_USER_ID = process.env.NAVER_USER_ID;
  process.env.NAVER_POSTER_PW = process.env.NAVER_USER_PW;
} else if (process.env.NAVER_POSTER_USER_ID && process.env.NAVER_POSTER_PW) {
  process.env.NAVER_USER_ID = process.env.NAVER_POSTER_USER_ID;
  process.env.NAVER_USER_PW = process.env.NAVER_POSTER_PW;
} else {
  console.error('[Unified] 네이버 계정 환경변수가 없습니다 (NAVER_USER_ID/PW). .env.local 확인 필요.');
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 교대 사이 짧은 간격 — 브라우저가 완전히 닫히고 락이 풀릴 여유를 준다 */
const SWITCH_GAP_MS = 3_000;

async function main() {
  const { crawlStartup, crawlTick, releaseCrawlBrowser } = await import('./naver-crawler-daemon');
  const { posterStartup, posterTick } = await import('./naver-poster-daemon');

  console.log('');
  console.log('════════ 통합 데몬 (수집 + 재업) ════════');
  console.log('  계정   :', process.env.NAVER_USER_ID);
  console.log('  프로필 :', PROFILE, '(하나로 통일)');
  console.log('  창 표시 :', process.env.NAVER_HEADLESS === 'false' ? '예 (headful)' : '아니오 (headless)');
  console.log('  로그인 재시도 상한 :', process.env.NAVER_MAX_LOGIN_ATTEMPTS || '3');
  console.log('  순서   : 수집 → 재업 → 반복 (같은 브라우저의 다른 탭, 동시 실행 없음)');
  console.log('═══════════════════════════════════════');
  console.log('');

  await crawlStartup();
  await posterStartup();

  let cycle = 0;
  while (true) {
    cycle += 1;
    try {
      // ── 수집 차례 ──
      await crawlTick();
      await sleep(SWITCH_GAP_MS);

      // ── 재업 차례 ──
      // 2026-10-31부터 둘이 **같은 브라우저의 다른 탭**을 쓴다(shared-browser.ts).
      // 그래서 전처럼 브라우저를 닫아 프로필 락을 넘겨줄 필요가 없다.
      // 순차 실행은 그대로 유지한다 — 같은 계정으로 두 작업이 동시에 돌면
      // 네이버가 동시 세션으로 보고, 그게 보호조치의 원인이었다.
      await posterTick();
      await sleep(SWITCH_GAP_MS);
    } catch (e: any) {
      console.error(`[Unified] 교대 루프 오류 (cycle ${cycle}):`, e?.message);
      // 터진 쪽의 작업 탭을 버린다 (브라우저는 그대로 둔다)
      try {
        await releaseCrawlBrowser();
      } catch {
        /* 이미 정리됐다 */
      }
      await sleep(10_000);
    }
  }
}

// 데몬을 끌 때 크롬을 죽이지 않는다 — 로그인된 창은 계속 살아 있어야 한다.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    console.log(`\n[Unified] ${sig} 수신 — 연결만 끊고 종료합니다 (크롬은 그대로 떠 있습니다).`);
    const { disconnectSharedBrowser } = await import('../src/lib/naver/shared-browser');
    await disconnectSharedBrowser().catch(() => {});
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('[Unified] 기동 실패:', e);
  process.exit(1);
});
