/**
 * 네이버 카페 포스팅 데몬 (항시 켜둔 머신에서 실행)
 *
 * 동작: Supabase posting_queue 테이블을 폴링 → PENDING 작업을 하나씩 claim →
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function claimJob(): Promise<any | null> {
  const { data: jobs } = await sb
    .from('posting_queue')
    .select('*')
    .eq('status', 'PENDING')
    .order('created_at', { ascending: true })
    .limit(1);
  if (!jobs || !jobs.length) return null;
  const job = jobs[0];
  // 원자적 claim: 여전히 PENDING일 때만 PROCESSING으로
  const { data: claimed } = await sb
    .from('posting_queue')
    .update({ status: 'PROCESSING', attempts: job.attempts + 1, updated_at: new Date().toISOString() })
    .eq('id', job.id)
    .eq('status', 'PENDING')
    .select();
  return claimed && claimed.length ? claimed[0] : null;
}

async function processJob(job: any) {
  const { uploadToNaverCafe } = await import('../src/lib/naver/uploader');
  const p = job.payload;
  const kind = p.type === 'REPOST' ? '재업(끌올)' : '신규 포스팅';
  console.log(`[Daemon] ▶ ${kind}: "${p.title}" (job ${job.id}, 시도 ${job.attempts})`);
  const result = await uploadToNaverCafe(p);
  if (result && result !== 'DELEGATED_TO_DAEMON') {
    await sb.from('posting_queue').update({ status: 'DONE', result_url: result, error: null, updated_at: new Date().toISOString() }).eq('id', job.id);
    if (p.productId) {
      const upd: Record<string, unknown> = {
        naver_article_url: result,
        posted_at: new Date().toISOString(), // 재업/신규 모두 카페 게시 시각 갱신 (어드민 📢 날짜)
      };
      // 실카페 포스팅일 때만 새 글ID 기록 → 다음 크롤 사이클이 existingIds로 본문 진입 자체를 스킵 (dedup 1차 방어)
      if (POST_CAFE_ID === CRAWL_CLUB_ID) {
        const articleId = result.match(/articles\/(\d+)/)?.[1] || result.match(/\/(\d+)(?:[/?#]|$)/)?.[1];
        if (articleId) upd.cafe_article_id = Number(articleId);
      }
      const { error: prodErr } = await sb.from('products').update(upd).eq('id', p.productId);
      if (prodErr) console.warn(`[Daemon] ⚠️ 상품 갱신 실패 (product ${p.productId}): ${prodErr.message}`);
    }
    console.log(`[Daemon] ✅ 완료 → ${result}`);
  } else {
    throw new Error('포스팅 결과 URL을 받지 못함 (멤버 권한/캡차/로그인 실패 가능)');
  }
}

async function loop() {
  console.log('[Daemon] 🟢 네이버 카페 포스팅 데몬 시작. 큐 폴링 중... (Ctrl+C 종료)');
  console.log('[Daemon] 프로필 경로:', process.env.NAVER_PROFILE_DIR);
  while (true) {
    try {
      const job = await claimJob();
      if (!job) { await sleep(POLL_MS); continue; }
      try {
        await processJob(job);
      } catch (e: any) {
        const isFinal = job.attempts >= (job.max_attempts || 3);
        await sb.from('posting_queue').update({
          status: isFinal ? 'FAILED' : 'PENDING',
          error: String(e?.message || e).slice(0, 500),
          updated_at: new Date().toISOString()
        }).eq('id', job.id);
        if (isFinal) {
          console.error(`[Daemon] 🔴 최종 실패 (job ${job.id}): ${e?.message} — 관리자 확인 필요`);
        } else {
          console.warn(`[Daemon] 🟡 실패, 재시도 대기 (job ${job.id}, ${job.attempts}/${job.max_attempts}): ${e?.message}`);
        }
      }
    } catch (loopErr: any) {
      console.error('[Daemon] 루프 오류:', loopErr?.message);
      await sleep(POLL_MS);
    }
  }
}

loop();
