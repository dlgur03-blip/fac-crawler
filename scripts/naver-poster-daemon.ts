/**
 * 네이버 카페 포스팅 데몬 (항시 켜둔 머신에서 실행)
 *
 * 동작: Supabase posting_queue 테이블을 폴링 → QUEUED/PENDING 작업을 하나씩 claim →
 *       Puppeteer로 네이버 카페에 포스팅 → 성공 시 DONE + products.naver_article_url 갱신,
 *       실패 시 재시도(attempts < max_attempts) 또는 FAILED.
 *
 * 실행: npm run naver-daemon   (내부적으로 tsx 사용)
 * 종료: Ctrl + C
 *
 * 필요 env (.env.local에서 자동 로드):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NAVER_USER_ID, NAVER_USER_PW
 *   NAVER_POSTER_USER_ID / NAVER_POSTER_PW (선택 — 설정 시 이 계정으로 포스팅. 예: 핫딜매니저)
 *   NAVER_POSTER_PROFILE_DIR (미설정 시 ./.naver_profile_poster — 크롤러 데몬과 프로필 분리,
 *                             동시 가동 시 Chromium userDataDir 락 충돌 방지)
 *   NAVER_POST_CAFE_ID (미설정 시 테스트 카페 31729221 — 실전환 시 28310071)
 */
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { reportDaemonStatus } from '../src/lib/naver/daemon-status';

// ---- .env.local 로드 (dotenv 없이 간단 파싱) ----
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

// 데몬은 직접 포스팅하므로 위임 모드 비활성화 (혹시 설정돼 있어도 무시)
delete process.env.NAVER_POSTER_PROXY_URL;

// 포스팅 전용 계정 override — 설정 시 uploader의 로그인이 이 계정을 쓴다 (예: 핫딜매니저)
if (process.env.NAVER_POSTER_USER_ID && process.env.NAVER_POSTER_PW) {
  process.env.NAVER_USER_ID = process.env.NAVER_POSTER_USER_ID;
  process.env.NAVER_USER_PW = process.env.NAVER_POSTER_PW;
  console.log('[Daemon] 포스팅 전용 계정 사용:', process.env.NAVER_POSTER_USER_ID);
}

// 로그인 세션 영속 디렉토리 — 크롤러 데몬(.naver_profile)과 분리 (동시 가동 시 프로필 락 충돌 방지)
process.env.NAVER_PROFILE_DIR =
  process.env.NAVER_POSTER_PROFILE_DIR || path.join(process.cwd(), '.naver_profile_poster');

// 포스팅 카페와 크롤 카페가 같을 때만 재업 글ID를 products.cafe_article_id에 기록
// (테스트 카페 글ID로 전역 UNIQUE 인덱스를 오염시키지 않기 위한 가드)
const POST_CAFE_ID = process.env.NAVER_POST_CAFE_ID || '31729221';
const CRAWL_CLUB_ID = process.env.NAVER_CAFE_CLUB_ID || '28310071';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!SUPA_URL || !SVC) {
  console.error('[Daemon] SUPABASE 환경변수 누락. .env.local 확인 필요.');
  process.exit(1);
}
const sb = createClient(SUPA_URL, SVC, { auth: { persistSession: false } });

const POLL_MS = 10_000;
const HEARTBEAT_MS = 60_000; // idle 상태에서도 생존 신호를 남기는 주기
// 포스터는 작업이 있을 때만 브라우저를 띄우므로 세션이 방치되면 네이버가 기기확인을 요구한다.
// 작업이 없어도 주기적으로 로그인 세션을 갱신해 "재업 요청 순간에야 로그인 깨진 걸 알게 되는" 상황을 막는다.
const SESSION_REFRESH_MS = Math.max(1, Number(process.env.SESSION_REFRESH_HOURS || 6)) * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastHeartbeatAt = 0;
let lastSessionCheckAt = 0;
let loginRequired = false; // 로그인 차단 감지 시 true — 세션 복구되면 해제

/** idle/working 생존 신호 (실패는 조용히 무시 — 본작업을 막지 않는다) */
async function beat(state: 'IDLE' | 'WORKING', detail?: Record<string, unknown>) {
  lastHeartbeatAt = Date.now();
  await reportDaemonStatus({
    name: 'poster',
    state: loginRequired ? 'LOGIN_REQUIRED' : state,
    detail: { postCafeId: POST_CAFE_ID, ...(detail || {}) }
  });
}

/**
 * 대기 작업 상태 — 신버전 데몬은 QUEUED와 PENDING을 모두 처리한다.
 * 신규 작업은 웹에서 QUEUED로 적재되므로 PENDING만 보는 구버전 데몬은 작업을 집어갈 수 없다
 * (포스터를 다른 PC로 이전할 때 이중 처리 방지용 원격 차단 스위치, 2026-07-30).
 * PENDING도 함께 폴링하는 이유: 구버전이 남긴 잔여 작업을 새 PC가 이어받을 수 있게.
 */
const WAITING_STATUSES = ['QUEUED', 'PENDING'] as const;

async function claimJob(): Promise<any | null> {
  const { data: jobs } = await sb
    .from('posting_queue')
    .select('*')
    .in('status', WAITING_STATUSES as unknown as string[])
    .order('created_at', { ascending: true })
    .limit(1);
  if (!jobs || !jobs.length) return null;
  const job = jobs[0];
  // 원자적 claim: 여전히 대기 상태일 때만 PROCESSING으로 (다른 데몬과 경합해도 1건만 성공)
  const { data: claimed } = await sb
    .from('posting_queue')
    .update({ status: 'PROCESSING', attempts: job.attempts + 1, updated_at: new Date().toISOString() })
    .eq('id', job.id)
    .eq('status', job.status)
    .select();
  return claimed && claimed.length ? claimed[0] : null;
}

/** 진단 정보를 실어 나르는 에러 — loop가 로그인 차단 여부를 판단해 즉시 중단할 수 있게 한다 */
class PostFailure extends Error {
  diag: any;
  constructor(message: string, diag: any) {
    super(message);
    this.diag = diag;
  }
}

async function processJob(job: any) {
  const { uploadToNaverCafe, getLastUploadDiagnostics, describeDiagnostics, getLastPostedBoardName } =
    await import('../src/lib/naver/uploader');
  const p = job.payload;
  const kind = p.type === 'REPOST' ? '재업(끌올)' : '신규 포스팅';
  console.log(`[Daemon] ▶ ${kind}: "${p.title}" (job ${job.id}, 시도 ${job.attempts})`);
  // 처리 중에도 생존 신호를 남겨 실제 hang과 긴 이미지 업로드를 구분한다.
  const heartbeat = setInterval(() => {
    void sb.from('posting_queue').update({ updated_at: new Date().toISOString() })
      .eq('id', job.id).eq('status', 'PROCESSING');
    void beat('WORKING', { jobId: job.id, title: p.title });
  }, 30_000);
  await beat('WORKING', { jobId: job.id, title: p.title });
  const result = await uploadToNaverCafe(p).finally(() => clearInterval(heartbeat));
  if (result && result !== 'DELEGATED_TO_DAEMON') {
    await sb.from('posting_queue').update({ status: 'DONE', result_url: result, error: null, updated_at: new Date().toISOString() }).eq('id', job.id);
    // 테스트 카페 포스팅은 products를 건드리지 않는다 (2026-08-01).
    // 기존에는 cafe_article_id만 실카페 가드가 있고 naver_article_url·posted_at은 무조건
    // 덮어썼다. 그 결과 테스트 카페로 검증 한 번 돌리면 실제 상품의 원본 글 링크가
    // 테스트 카페 글로 바뀌어, 이후 재업이 "원본 게시판=자유게시판"을 읽고 실카페에서
    // 그 게시판을 못 찾아 실패했다(실측 2건). 테스트 결과는 DB에 남기지 않는 것이 맞다.
    const isRealCafe = POST_CAFE_ID === CRAWL_CLUB_ID;
    if (p.productId && isRealCafe) {
      const upd: Record<string, unknown> = {
        naver_article_url: result,
        posted_at: new Date().toISOString(), // 재업/신규 모두 카페 게시 시각 갱신 (어드민 📢 날짜)
      };
      // 새 글ID 기록 → 다음 크롤 사이클이 existingIds로 본문 진입 자체를 스킵 (dedup 1차 방어)
      const articleId = result.match(/articles\/(\d+)/)?.[1] || result.match(/\/(\d+)(?:[/?#]|$)/)?.[1];
      if (articleId) upd.cafe_article_id = Number(articleId);

      // 방금 올린 게시판을 기록 → 다음 재업은 카페 글을 열지 않아도 된다.
      // (원본 글이 삭제되면 게시판을 못 읽어 재업이 막히던 문제의 근본 해결)
      const boardName = getLastPostedBoardName();
      if (boardName) upd.cafe_board_name = boardName;

      let { error: prodErr } = await sb.from('products').update(upd).eq('id', p.productId);

      // cafe_board_name 컬럼이 아직 없는 환경(마이그레이션 미적용)이면 그 필드만 빼고 재시도한다.
      // 게시판 기록 실패가 재업 자체를 실패로 만들면 안 된다.
      if (prodErr && boardName && /cafe_board_name/.test(prodErr.message)) {
        console.warn('[Daemon] ⚠️ cafe_board_name 컬럼이 없어 게시판 기록을 생략합니다 (마이그레이션 필요)');
        delete upd.cafe_board_name;
        ({ error: prodErr } = await sb.from('products').update(upd).eq('id', p.productId));
      }
      if (prodErr) console.warn(`[Daemon] ⚠️ 상품 갱신 실패 (product ${p.productId}): ${prodErr.message}`);
    } else if (p.productId) {
      console.log(
        `[Daemon] 🧪 테스트 카페(${POST_CAFE_ID}) 게시 — products 갱신 생략 (실카페는 ${CRAWL_CLUB_ID})`
      );
    }
    console.log(`[Daemon] ✅ 완료 → ${result}`);
    loginRequired = false;
    await reportDaemonStatus({ name: 'poster', state: 'IDLE', markSuccess: true, lastError: null, detail: { lastResultUrl: result } });
  } else {
    // 실패 원인을 uploader가 남긴 진단으로 특정한다 (기존에는 한 줄 추측 문구만 남았음)
    const diag = getLastUploadDiagnostics();
    throw new PostFailure(describeDiagnostics(diag), diag);
  }
}

/**
 * 세션 주기 점검 — 작업이 없어도 로그인 세션을 살려두고, 깨졌으면 즉시 알린다.
 * (대표님 지적: "쓸 때만 로그인하니까 텀에 로그인 인증이 걸려버린다")
 */
async function refreshSessionIfDue() {
  if (Date.now() - lastSessionCheckAt < SESSION_REFRESH_MS) return;
  lastSessionCheckAt = Date.now();

  const { ensurePosterSession, describeDiagnostics } = await import('../src/lib/naver/uploader');
  console.log('[Daemon] 🔄 로그인 세션 주기 점검 시작...');
  const { ok, diagnostics } = await ensurePosterSession();

  if (ok) {
    loginRequired = false;
    await reportDaemonStatus({ name: 'poster', state: 'IDLE', markLoginCheck: true, lastError: null });
    console.log('[Daemon] ✅ 세션 정상 — 다음 점검까지 대기');
  } else {
    loginRequired = true;
    await reportDaemonStatus({
      name: 'poster',
      state: 'LOGIN_REQUIRED',
      lastError: describeDiagnostics(diagnostics),
      detail: { diagnostics, source: 'session-refresh' }
    });
    console.error('[Daemon] 🔴 세션 점검 실패 — 수동 재로그인 필요 (NAVER_HEADLESS=false)');
  }
}

async function loop() {
  console.log('[Daemon] 🟢 네이버 카페 포스팅 데몬 시작. 큐 폴링 중... (Ctrl+C 종료)');
  console.log('[Daemon] 프로필 경로:', process.env.NAVER_PROFILE_DIR);
  console.log(`[Daemon] 세션 주기 점검: ${SESSION_REFRESH_MS / 3_600_000}시간마다`);
  await beat('IDLE');
  // 기동 직후 1회 세션 점검 — 새 PC 설치 후 로그인 상태를 바로 확인할 수 있게 한다
  await refreshSessionIfDue().catch((e) => console.warn('[Daemon] 초기 세션 점검 실패:', e?.message));

  while (true) {
    try {
      const job = await claimJob();
      if (!job) {
        if (Date.now() - lastHeartbeatAt >= HEARTBEAT_MS) await beat('IDLE');
        await refreshSessionIfDue().catch((e) => console.warn('[Daemon] 세션 점검 실패:', e?.message));
        await sleep(POLL_MS);
        continue;
      }
      try {
        await processJob(job);
      } catch (e: any) {
        const diag = e?.diag ?? null;
        const { isLoginBlocked } = await import('../src/lib/naver/uploader');
        const blocked = isLoginBlocked(diag);

        // 로그인/캡차 차단은 재시도해도 무조건 실패한다. 3회 헛시도로 계정을 더 자극하지 않고 즉시 중단.
        const isFinal = blocked || job.attempts >= (job.max_attempts || 3);
        await sb.from('posting_queue').update({
          // 재시도는 QUEUED로 되돌린다 (PENDING이면 구버전 데몬이 가로챌 수 있음)
          status: isFinal ? 'FAILED' : 'QUEUED',
          error: String(e?.message || e).slice(0, 500),
          result: diag ? { diagnostics: diag, loginBlocked: blocked } : null,
          updated_at: new Date().toISOString()
        }).eq('id', job.id);

        if (blocked) {
          loginRequired = true;
          await reportDaemonStatus({
            name: 'poster',
            state: 'LOGIN_REQUIRED',
            lastError: String(e?.message || e),
            bumpFailure: true,
            detail: { diagnostics: diag, jobId: job.id, source: 'job' }
          });
          console.error(`[Daemon] 🔴 로그인 차단 감지 — 재시도 중단, 수동 재로그인 필요 (job ${job.id}): ${e?.message}`);
        } else {
          await reportDaemonStatus({
            name: 'poster',
            state: 'ERROR',
            lastError: String(e?.message || e),
            bumpFailure: true,
            detail: { diagnostics: diag, jobId: job.id, source: 'job' }
          });
          if (isFinal) {
            console.error(`[Daemon] 🔴 최종 실패 (job ${job.id}): ${e?.message} — 관리자 확인 필요`);
          } else {
            console.warn(`[Daemon] 🟡 실패, 재시도 대기 (job ${job.id}, ${job.attempts}/${job.max_attempts}): ${e?.message}`);
          }
        }
      }
    } catch (loopErr: any) {
      console.error('[Daemon] 루프 오류:', loopErr?.message);
      await sleep(POLL_MS);
    }
  }
}

loop();
