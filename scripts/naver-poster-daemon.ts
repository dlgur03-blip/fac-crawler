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

/**
 * 로그인 세션 점검 주기 — **매번 무작위로 뽑는다.** (2026-10-30 대표님 지시)
 *
 * 두 가지를 노린다.
 *  ① **세션 유지.** 포스터는 작업이 있을 때만 브라우저를 띄우므로 방치하면 세션이 삭는다.
 *     기존 6시간은 너무 길어 10/29에도 로그인이 끊긴 채 하루 반을 멈춰 있었다.
 *  ② **기계 같은 리듬 제거.** 정확히 N시간마다 같은 동작을 하면 네이버 쪽에서 자동화로
 *     보기 쉽다. 사람은 그렇게 규칙적으로 접속하지 않는다.
 *
 * 점검 자체는 가볍고 안전하다 — 세션이 살아 있으면 네이버 홈을 한 번 열어 **쿠키만**
 * 확인하고 끝난다(uploader.ts의 hasLiveSession). 비밀번호는 세션이 끊겼을 때만 넣고,
 * 그마저 연속 3회에서 멈춘다(loginToNaver의 차단기). 그래서 자주 돌려도 계정에 무리가 없다.
 */
const SESSION_MIN_MIN = Math.max(1, Number(process.env.SESSION_REFRESH_MIN_MINUTES || 10));
const SESSION_MAX_MIN = Math.max(SESSION_MIN_MIN, Number(process.env.SESSION_REFRESH_MAX_MINUTES || 20));

/** 다음 점검까지 기다릴 시간을 [최소, 최대] 사이에서 새로 뽑는다 */
function pickSessionInterval(): number {
  const span = SESSION_MAX_MIN - SESSION_MIN_MIN;
  return Math.round((SESSION_MIN_MIN + Math.random() * span) * 60 * 1000);
}

/**
 * PC가 절전에 들어갔다 깨어난 것을 감지하는 기준. (2026-10-30)
 *
 * 2026-10-28 23:40에 사람이 PC를 재웠고(모던 대기 S0), 7시간 넘게 자는 동안 세션 갱신이
 * 멈췄다. 깨어나서 로그인하니 네이버가 "오래 끊겼던 기기"로 보고 기기확인을 요구했고,
 * 자동화는 그걸 넘지 못해 결국 계정에 보호조치까지 걸렸다.
 *
 * 절전 중에는 setTimeout도 같이 멈춘다. 그래서 **폴링 한 바퀴에 걸린 실제 시간**이
 * 비정상적으로 크면 그 사이 잠들어 있었다고 본다. 폴링이 10초인데 3분을 넘겼다면
 * 정상적인 지연이 아니다.
 */
const WAKE_GAP_MS = 3 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastHeartbeatAt = 0;
let lastSessionCheckAt = 0;
/** 직전 루프 시각 — 절전 복귀 감지용 */
let lastTickAt = Date.now();
/** 이번에 뽑힌 대기 시간 — 점검할 때마다 다시 뽑는다 */
let sessionIntervalMs = pickSessionInterval();
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

/**
 * "실패"가 아니라 "제외"로 봐야 하는 작업인지 판정한다 (2026-08-01).
 * 제외 사유가 있으면 사람이 읽을 문구를, 정상 처리 대상이면 null을 반환한다.
 *
 * 기준은 "대상 상품이 존재하지 않아 애초에 수행 불가"다. 재업 자체가 실패한 것과 구분해야
 * 관리자가 실제로 손봐야 할 건수를 알 수 있다.
 */
async function classifyExcluded(p: any): Promise<string | null> {
  if (!p?.productId) return '대상 상품이 지정되지 않은 작업입니다 (설치 확인용 테스트 글 등)';

  const { data, error } = await sb.from('products').select('id').eq('id', p.productId).maybeSingle();
  // 조회 자체가 실패하면 제외로 단정하지 않는다 — 일시 오류로 작업을 버리면 안 된다
  if (error) return null;
  if (!data) return '대상 상품이 삭제되어 재업할 수 없습니다';
  return null;
}

async function processJob(job: any) {
  const { uploadToNaverCafe, getLastUploadDiagnostics, describeDiagnostics, getLastPostedBoardName } =
    await import('../src/lib/naver/uploader');
  const p = job.payload;
  const kind = p.type === 'REPOST' ? '재업(끌올)' : '신규 포스팅';

  // 대상 상품이 아예 없는 작업은 "실패"가 아니라 "제외"다 — 재시도해도 달라질 게 없으므로
  // 브라우저를 띄우지 않고 즉시 종료한다. 관리자 화면도 이 플래그로 실패와 구분해 표기한다.
  // (설치 확인용 [테스트] 글처럼 productId가 없는 작업, 상품이 이미 삭제된 작업) 2026-08-01
  const excluded = await classifyExcluded(p);
  if (excluded) {
    await sb.from('posting_queue').update({
      status: 'FAILED',
      error: excluded,
      result: { excluded: true, reason: excluded },
      updated_at: new Date().toISOString()
    }).eq('id', job.id);
    console.log(`[Daemon] ⏭️ 제외: "${p.title}" — ${excluded}`);
    return;
  }

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
  if (Date.now() - lastSessionCheckAt < sessionIntervalMs) return;
  lastSessionCheckAt = Date.now();
  // 다음 점검 간격을 새로 뽑는다 — 같은 간격이 반복되지 않게
  sessionIntervalMs = pickSessionInterval();

  const { ensurePosterSession, describeDiagnostics } = await import('../src/lib/naver/uploader');
  console.log('[Daemon] 🔄 로그인 세션 주기 점검 시작...');
  const { ok, diagnostics } = await ensurePosterSession();

  if (ok) {
    loginRequired = false;
    await reportDaemonStatus({ name: 'poster', state: 'IDLE', markLoginCheck: true, lastError: null });
    console.log(`[Daemon] ✅ 세션 정상 — 다음 점검까지 ${Math.round(sessionIntervalMs / 60000)}분 대기`);
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

/** 기동 시 한 번 — 생존 신호 + 즉시 세션 점검 */
export async function posterStartup() {
  console.log('[Daemon] 🟢 네이버 카페 포스팅 데몬 시작. 큐 폴링 중... (Ctrl+C 종료)');
  console.log('[Daemon] 프로필 경로:', process.env.NAVER_PROFILE_DIR);
  console.log(`[Daemon] 세션 점검: ${SESSION_MIN_MIN}~${SESSION_MAX_MIN}분 사이 무작위 (이번 대기 ${Math.round(sessionIntervalMs/60000)}분)`);
  await beat('IDLE');
  // 기동 직후 1회 세션 점검 — 새 PC 설치 후 로그인 상태를 바로 확인할 수 있게 한다
  await refreshSessionIfDue().catch((e) => console.warn('[Daemon] 초기 세션 점검 실패:', e?.message));
}

/**
 * 루프 한 바퀴 (2026-10-30 분리).
 *
 * 통합 데몬이 수집과 번갈아 호출한다. 재업은 작업마다 자기 브라우저를 열고 닫으므로
 * (uploadToNaverCafe / ensurePosterSession), 수집기가 브라우저를 닫아둔 동안에만 돌면
 * 같은 프로필을 안전하게 공유할 수 있다.
 */
export async function posterTick() {
    try {
      // 절전에서 깨어났으면 **기다리지 않고 바로** 세션을 점검한다. (2026-10-30)
      // 자는 동안 네이버 세션이 삭는다. 다음 주기(최대 20분)까지 두면 그 사이에 들어온
      // 재업 작업이 로그인 실패로 날아가고, 실패가 쌓이면 계정이 보호조치로 묶인다.
      {
        const gap = Date.now() - lastTickAt;
        lastTickAt = Date.now();
        if (gap > WAKE_GAP_MS) {
          console.log(`[Daemon] ⏰ ${Math.round(gap / 60000)}분 공백 감지 (절전 복귀 추정) — 세션 즉시 점검`);
          lastSessionCheckAt = 0; // 주기를 무시하고 지금 점검하게 만든다
        }
      }

      const job = await claimJob();
      if (!job) {
        if (Date.now() - lastHeartbeatAt >= HEARTBEAT_MS) await beat('IDLE');
        await refreshSessionIfDue().catch((e) => console.warn('[Daemon] 세션 점검 실패:', e?.message));
        await sleep(POLL_MS);
        return; // 한 바퀴 끝 (전에는 while 루프의 continue 였다)
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

/** 재업기만 단독으로 돌릴 때의 루프 */
async function loop() {
  await posterStartup();
  while (true) await posterTick();
}

// 통합 데몬(scripts/naver-unified-daemon.ts)이 import 할 때는 자체 루프를 돌리지 않는다.
if (process.env.NAVER_DAEMON_MODE !== 'unified') loop();
