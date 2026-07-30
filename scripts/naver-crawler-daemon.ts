/**
 * 네이버 카페 크롤러 데몬 (항시 켜둔 머신에서 실행)
 *
 * 동작: Supabase crawl_queue 테이블을 폴링 → PENDING 작업을 원자적으로 claim →
 *       로그인된 영속 Puppeteer 세션으로 카페 전체글 목록/상세를 크롤링 →
 *       products 테이블에 신규 INSERT / 재게시(끌어올림) UPDATE / 중복 스킵.
 *       또한 10분마다 스스로 SCHEDULED 작업을 만들어 동일 경로로 실행
 *       (모든 실행이 crawl_queue에 로그로 남음).
 *
 * 실행: npm run crawler-daemon   (내부적으로 tsx 사용)
 * 종료: Ctrl + C
 *
 * 필요 env (.env.local에서 자동 로드):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NAVER_USER_ID, NAVER_USER_PW
 *   NAVER_PROFILE_DIR (미설정 시 ./.naver_profile — 포스팅 데몬과 동시 가동 시 프로필 분리 필수:
 *                      포스팅 데몬은 기본 ./.naver_profile_poster 사용, Chromium userDataDir 락 충돌 방지)
 *   NAVER_CAFE_CLUB_ID (미설정 시 28310071)
 */
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import type { Browser, Page } from 'puppeteer';
import type { CafeListItem } from '../src/lib/naver/crawler';
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

// 로그인 세션 영속 디렉토리 (포스팅 데몬과 공유)
if (!process.env.NAVER_PROFILE_DIR) {
  process.env.NAVER_PROFILE_DIR = path.join(process.cwd(), '.naver_profile');
}
const CLUB_ID = process.env.NAVER_CAFE_CLUB_ID || '28310071';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!SUPA_URL || !SVC) {
  console.error('[CrawlDaemon] SUPABASE 환경변수 누락. .env.local 확인 필요.');
  process.exit(1);
}
const sb = createClient(SUPA_URL, SVC, { auth: { persistSession: false } });

const POLL_MS = 15_000;          // 큐 폴링 주기
const SCHEDULE_MS = 10 * 60_000; // 자체 스케줄 크롤 주기 (10분)
const HEARTBEAT_MS = 60_000;     // 크롤 중 crawl_queue.updated_at 갱신 주기 (스로틀)
const STALL_MS = 10 * 60_000;    // watchdog: 작업 중 무진행 10분이면 좀비로 판정 (아이템 1건 최악 ~2분의 5배)
const STALE_JOB_MS = 15 * 60_000;// 큐의 PROCESSING 행이 15분 무갱신이면 죽은 데몬의 잔재로 판정
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 하부 puppeteer 작업이 protocolTimeout까지 뚫고 wedge되는 케이스 방어.
 * 타임아웃 시 아이템 레벨에서 삼키지 않고 job 레벨로 throw해야 한다 —
 * 취소 불가능한 promise를 남긴 채 같은 page를 계속 쓰면 위험하므로,
 * outer catch가 resetBrowser() 후 큐 재시도(existingIds 스킵으로 자연 재개)하는 경로를 탄다.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[Timeout] ${label} ${ms / 1000}s 초과`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// ---- watchdog/heartbeat 상태 ----
let currentJobId: string | null = null;   // 처리 중인 crawl_queue job id (idle이면 null)
let lastProgressAt = Date.now();          // 마지막 진행 시각 — 아이템 루프/폴링에서 갱신
let lastHeartbeatAt = 0;                  // DB heartbeat 스로틀

function markProgress() {
  lastProgressAt = Date.now();
}

/** 크롤 진행 중 60초 스로틀로 crawl_queue.updated_at + 진행 카운트 갱신 (어드민 배너가 이걸 봄) */
async function heartbeat(jobId: string, progress: { done: number; total: number }) {
  markProgress();
  if (Date.now() - lastHeartbeatAt < HEARTBEAT_MS) return;
  lastHeartbeatAt = Date.now();
  try {
    await sb
      .from('crawl_queue')
      .update({ updated_at: new Date().toISOString(), result: { progress } })
      .eq('id', jobId)
      .eq('status', 'PROCESSING');
    // 데몬 생존 상태도 함께 기록 (관리자 화면의 크롤러/포스터 통합 배너용, 2026-07-30)
    await reportDaemonStatus({ name: 'crawler', state: 'WORKING', detail: { jobId, progress } });
  } catch { /* heartbeat 실패는 크롤을 막지 않음 */ }
}

/**
 * 좀비 PROCESSING 회수 — hang 중 프로세스가 죽으면 PROCESSING 행이 영구 잔류하고,
 * hasActiveJob()이 이를 활성으로 봐서 재시작 후에도 SCHEDULED 크롤이 영원히 생성되지 않던 버그의 수정.
 * heartbeat(≤60초 간격) 덕분에 15분 무갱신 PROCESSING = 확실한 좀비.
 */
async function recoverStaleJobs() {
  try {
    const cutoff = new Date(Date.now() - STALE_JOB_MS).toISOString();
    const { data: stale } = await sb
      .from('crawl_queue')
      .select('id, attempts, max_attempts')
      .eq('status', 'PROCESSING')
      .lt('updated_at', cutoff);
    for (const j of stale || []) {
      const isFinal = j.attempts >= (j.max_attempts || 3);
      await sb
        .from('crawl_queue')
        .update({
          status: isFinal ? 'FAILED' : 'PENDING',
          error: `좀비 PROCESSING 회수 (${STALE_JOB_MS / 60_000}분 무갱신 — 데몬 사망/hang 추정)`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', j.id)
        .eq('status', 'PROCESSING');
      console.warn(`[CrawlDaemon] ♻️ 좀비 작업 회수: job ${j.id} → ${isFinal ? 'FAILED' : 'PENDING'}`);
    }
  } catch (e: any) {
    console.warn('[CrawlDaemon] 좀비 작업 회수 실패(무시):', e?.message);
  }
}

/** 내부 watchdog: 작업 중 STALL_MS 무진행이면 큐를 되돌리고 자폭 → 윈도우 래퍼(crawler-daemon-loop.cmd)가 10초 후 재기동 */
function startWatchdog() {
  setInterval(async () => {
    if (currentJobId === null) return;
    if (Date.now() - lastProgressAt <= STALL_MS) return;
    console.error(`[CrawlDaemon] 🐶 watchdog: ${STALL_MS / 60_000}분 무진행 (job ${currentJobId}) — 프로세스 재시작`);
    try {
      await sb
        .from('crawl_queue')
        .update({ status: 'PENDING', error: 'watchdog 재시작 (무진행 감지)', updated_at: new Date().toISOString() })
        .eq('id', currentJobId)
        .eq('status', 'PROCESSING');
    } catch { /* best effort */ }
    process.exit(1);
  }, 30_000);
}

export interface CrawlResult {
  scanned: number;
  inserted: number;
  reposted: number;
  skipped: number;
  failed: number;
  warnings: string[];
}

// ---- 브라우저 1회 launch + 페이지 재사용 + 크래시 시 재기동 ----
let browser: Browser | null = null;
let pageRef: Page | null = null;

async function getPage(): Promise<Page> {
  if (browser && browser.connected && pageRef && !pageRef.isClosed()) {
    return pageRef;
  }
  await resetBrowser();
  const puppeteer = (await import('puppeteer')).default;
  console.log('[CrawlDaemon] 브라우저 기동 중... (프로필:', process.env.NAVER_PROFILE_DIR, ')');
  browser = await puppeteer.launch({
    // NAVER_HEADLESS=false 면 창 표시 — 새 기기 첫 로그인에서 캡차/기기확인을 눈으로 처리할 때 사용
    headless: process.env.NAVER_HEADLESS === 'false' ? false : true,
    userDataDir: process.env.NAVER_PROFILE_DIR,
    // CDP 응답 무한 대기(hang의 전형)를 에러로 전환 — withTimeout/watchdog과 함께 3중 방어
    protocolTimeout: 120_000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1280,1024',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  pageRef = await browser.newPage();
  // timeout 미지정 waitFor/goto(uploader.ts 로그인 경로 포함)까지 전부 커버하는 기본 타임아웃
  pageRef.setDefaultTimeout(30_000);
  pageRef.setDefaultNavigationTimeout(35_000);
  await pageRef.setViewport({ width: 1280, height: 1024 });
  await pageRef.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  return pageRef;
}

async function resetBrowser() {
  if (browser) {
    try { await browser.close(); } catch { /* 이미 죽은 브라우저 */ }
  }
  browser = null;
  pageRef = null;
}

async function ensureLogin(page: Page) {
  const { loginToNaver } = await import('../src/lib/naver/uploader');
  const ok = await loginToNaver(page);
  if (!ok) {
    throw new Error('네이버 로그인 실패 (캡차/계정정보/세션 만료 가능)');
  }
}

// ---- 상품코드 생성: /api/products/create와 동일한 9자리 순차 코드 정책 ----
async function computeNextProductCode(): Promise<number> {
  let next = 100000001;
  try {
    const { data: latestProducts } = await sb
      .from('products')
      .select('product_code')
      .order('created_at', { ascending: false });

    if (latestProducts && latestProducts.length > 0) {
      const numericCodes = latestProducts
        .map((p: any) => parseInt(p.product_code, 10))
        .filter((code: number) => !isNaN(code) && code >= 100000000 && code <= 999999999);

      if (numericCodes.length > 0) {
        next = Math.max(...numericCodes) + 1;
      } else {
        next = 100000001 + latestProducts.length;
      }
    }
  } catch (codeErr) {
    console.warn('[CrawlDaemon] 상품코드 계산 실패 — 기본 시작값 사용:', codeErr);
  }
  return next;
}

// ---- 크롤 본체 ----
// stopAfterDupes > 0 이면 연속 중복(dedup 스킵) 그 횟수 도달 시 조기 종료 — "중복 전까지" 대량 수집용
async function runCrawl(page: Page, jobId: string, limit = 200, stopAfterDupes = 0): Promise<CrawlResult> {
  const { scrapeCafeList, scrapeCafeDetail, extractLinkedCafeUrls, resolveCafeArticleIdFromUrl, detectSoldoutFromTitle } =
    await import('../src/lib/naver/crawler');
  const { buildDedupKey } = await import('../src/lib/naver/dedup');

  const warnings: string[] = [];
  let inserted = 0;
  let reposted = 0;
  let skipped = 0;
  let failed = 0;

  // 1) 목록 수집 → 공지 제외 → 최신 limit건
  const list: CafeListItem[] = await withTimeout(scrapeCafeList(page, CLUB_ID, limit), 10 * 60_000, 'scrapeCafeList');
  markProgress();
  const candidates = list
    .filter((i) => !i.isNotice)
    .sort((a, b) => b.articleId - a.articleId)
    .slice(0, limit);
  const scanned = candidates.length;

  // 2) 기존 cafe_article_id 전체 Set — 미존재 ID만 본문 진입 (봇탐지 회피)
  const existingIds = new Set<number>();
  {
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await sb
        .from('products')
        .select('cafe_article_id')
        .not('cafe_article_id', 'is', null)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`기존 cafe_article_id 조회 실패: ${error.message}`);
      (data || []).forEach((r: any) => {
        if (r.cafe_article_id !== null && r.cafe_article_id !== undefined) {
          existingIds.add(Number(r.cafe_article_id));
        }
      });
      if (!data || data.length < PAGE) break;
      from += PAGE;
    }
  }

  // 2-b) 비상품 영구 스킵 캐시 — 출석/후기 등 가격 없는 글의 매 사이클 본문 재진입 방지
  const ignoredIds = new Set<number>();
  {
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await sb
        .from('crawl_ignored_articles')
        .select('cafe_article_id')
        .range(from, from + PAGE - 1);
      if (error) {
        warnings.push(`비상품 스킵 캐시 조회 실패(스킵 없이 진행): ${error.message}`);
        break;
      }
      (data || []).forEach((r: any) => {
        if (r.cafe_article_id !== null && r.cafe_article_id !== undefined) {
          ignoredIds.add(Number(r.cafe_article_id));
        }
      });
      if (!data || data.length < PAGE) break;
      from += PAGE;
    }
  }

  // 3) 활성 매니저 닉네임 → id 맵
  const managerMap = new Map<string, string>();
  {
    const { data: managers, error: mgrErr } = await sb
      .from('managers')
      .select('id, cafe_nickname')
      .eq('is_active', true);
    if (mgrErr) {
      warnings.push(`매니저 목록 조회 실패(매칭 생략): ${mgrErr.message}`);
    } else {
      (managers || []).forEach((m: any) => {
        if (m.cafe_nickname) managerMap.set(String(m.cafe_nickname).trim(), m.id);
      });
    }
  }

  // 3-b) 작성자 블록리스트 — 해당 닉네임 글은 크롤 자체 스킵 (2026-07-10 굿걸스텝 제외 등)
  const blockedAuthors = new Set<string>();
  {
    const { data: blocked, error: blkErr } = await sb.from('crawl_blocked_authors').select('nickname');
    if (blkErr) {
      warnings.push(`블록리스트 조회 실패(차단 없이 진행): ${blkErr.message}`);
    } else {
      (blocked || []).forEach((b: any) => {
        if (b.nickname) blockedAuthors.add(String(b.nickname).trim());
      });
    }
  }

  // 4) 미존재 + 비상품 캐시 + 블록 작성자 제외, 올라온 순서(오름차순)로 처리
  // (목록의 author는 폴백 체인이라 빈 값일 수 있음 — 상세 파싱 후 이중 가드 있음)
  const targets = candidates
    .filter((c) => !existingIds.has(c.articleId) && !ignoredIds.has(c.articleId))
    .filter((c) => !blockedAuthors.has((c.author || '').trim()))
    .sort((a, b) => a.articleId - b.articleId);

  const ignoredHit = candidates.filter((c) => !existingIds.has(c.articleId) && ignoredIds.has(c.articleId)).length;
  const blockedHit = candidates.filter((c) => blockedAuthors.has((c.author || '').trim())).length;
  console.log(`[CrawlDaemon] 목록 ${scanned}건 중 신규 후보 ${targets.length}건 본문 수집 시작... (비상품 캐시 스킵 ${ignoredHit}건, 블록 작성자 스킵 ${blockedHit}건)`);

  let codeCursor = await computeNextProductCode();

  // "중복 전까지" 모드: 최신→과거로 내려가며 연속 중복(dedup 스킵) N건이면 조기 종료
  // (기본 모드는 과거→최신 순으로 등록 순서 보존)
  const orderedTargets = stopAfterDupes > 0
    ? [...targets].sort((a, b) => b.articleId - a.articleId)
    : targets;
  let dupeStreak = 0;
  let done = 0;

  // 영구 스킵 캐시 등록 헬퍼 (비상품/블록작성자/처리완료 끌올 글)
  const markIgnored = async (articleId: number, reason: string, title: string) => {
    const { error: ignErr } = await sb
      .from('crawl_ignored_articles')
      .upsert(
        { cafe_article_id: articleId, reason, title: title.slice(0, 200) },
        { onConflict: 'cafe_article_id' }
      );
    if (ignErr) {
      warnings.push(`#${articleId} 스킵 캐시(${reason}) 등록 실패: ${ignErr.message}`);
    } else {
      ignoredIds.add(articleId);
    }
  };

  for (const t of orderedTargets) {
    done++;
    await heartbeat(jobId, { done, total: orderedTargets.length });
    await sleep(2000 + Math.floor(Math.random() * 2000)); // 건당 2~4초 랜덤 지연

    try {
      const detail = await withTimeout(scrapeCafeDetail(page, CLUB_ID, t.articleId), 90_000, `scrapeCafeDetail #${t.articleId}`);
      if (!detail) {
        failed++;
        warnings.push(`#${t.articleId} 상세 파싱 실패 (제목/본문 추출 불가)`);
        continue;
      }

      // 작성자 블록리스트 이중 가드 — 목록 author가 빈 값이어도 상세에서 확실히 차단 + 캐시로 재진입 방지
      if (detail.authorNickname && blockedAuthors.has(detail.authorNickname.trim())) {
        await markIgnored(t.articleId, 'blocked_author', detail.title);
        console.log(`[CrawlDaemon] ⛔ #${t.articleId} 블록 작성자(${detail.authorNickname.trim()}) — 스킵 캐시 등록`);
        continue;
      }

      if (detail.sourcePrice === null) {
        // 링크 끌어올림 글: 본문이 원본 글 링크 한 줄뿐인 지배적 패턴 — 원본을 따라가 가격/본문/이미지 회수.
        // 2026-07-10 변경: 원본이 이미 적재돼 있어도 반드시 들어가 최신 정보(가격/품절/옵션)를 갱신하고
        // posted_at을 끌올 글 시각으로 전진시킨다 (기존엔 스킵 → "링크만 있으면 안 들어간다" 문제).
        let resolvedFromLink = false;
        let repostHandled = false;
        const linkedUrls = extractLinkedCafeUrls(detail.content);
        for (const linkedUrl of linkedUrls) {
          const ref = await withTimeout(resolveCafeArticleIdFromUrl(page, linkedUrl), 60_000, `resolveLink #${t.articleId}`);
          if (!ref || (ref.clubId && ref.clubId !== CLUB_ID) || ref.articleId === t.articleId) continue;

          await sleep(1500 + Math.floor(Math.random() * 1500));
          const orig = await withTimeout(scrapeCafeDetail(page, CLUB_ID, ref.articleId), 90_000, `scrapeOrigin #${ref.articleId}`);

          // 원본 작성자가 블록리스트면 끌올 글째로 영구 스킵
          if (orig && orig.authorNickname && blockedAuthors.has(orig.authorNickname.trim())) {
            await markIgnored(t.articleId, 'blocked_author', detail.title);
            console.log(`[CrawlDaemon] ⛔ #${t.articleId} 끌올 원본(#${ref.articleId}) 작성자 블록 — 스킵 캐시 등록`);
            repostHandled = true;
            break;
          }

          if (existingIds.has(ref.articleId)) {
            // ★ 기적재 원본의 끌올 → 최신 정보로 UPDATE + posted_at 전진
            const { data: prod } = await sb
              .from('products')
              .select('id, posted_at')
              .eq('cafe_article_id', ref.articleId)
              .maybeSingle();
            const newPostedAt = detail.postedAt || new Date().toISOString();
            const prevPostedMs = prod?.posted_at ? new Date(prod.posted_at).getTime() : 0;

            if (prod && new Date(newPostedAt).getTime() > prevPostedMs) {
              const upd: Record<string, unknown> = {
                posted_at: newPostedAt,
                is_active: true,
              };
              if (orig && orig.sourcePrice !== null) {
                upd.source_price = orig.sourcePrice;
                upd.fee = orig.fee;
                upd.price = orig.sourcePrice + orig.fee;
                upd.content = orig.content;
                // 파싱값이 비어있으면 필드 제외 — 어드민 수동 보정값 보호
                if (orig.sizes) upd.sizes = orig.sizes;
                if (orig.colors) upd.colors = orig.colors;
                if (orig.authorNickname) upd.author_nickname = orig.authorNickname.trim();
                upd.is_soldout = detectSoldoutFromTitle(detail.title) || detectSoldoutFromTitle(orig.title);
                // 가격 변동 시 dedup_key 재계산 (충돌 시 키 갱신만 생략)
                const newKey = buildDedupKey(orig.title, orig.sourcePrice);
                const { error: keyErr } = await sb.from('products').update({ dedup_key: newKey }).eq('id', prod.id).neq('dedup_key', newKey);
                if (keyErr && keyErr.code === '23505') {
                  warnings.push(`#${ref.articleId} dedup_key 재계산 충돌 — 키 갱신 생략`);
                } else if (keyErr && keyErr.code !== '23505') {
                  warnings.push(`#${ref.articleId} dedup_key 갱신 실패: ${keyErr.message}`);
                }
              }
              const { error: upErr } = await sb.from('products').update(upd).eq('id', prod.id);
              if (upErr) {
                failed++;
                warnings.push(`#${t.articleId} 끌올 갱신 실패(원본 #${ref.articleId}): ${upErr.message}`);
              } else {
                if (orig && orig.imageUrls.length > 0) {
                  await sb.from('product_images').delete().eq('product_id', prod.id);
                  const { error: imgErr } = await sb.from('product_images').insert(
                    orig.imageUrls.map((url, idx) => ({ product_id: prod.id, image_url: url, display_order: idx }))
                  );
                  if (imgErr) warnings.push(`#${t.articleId} 끌올 이미지 적재 실패: ${imgErr.message}`);
                }
                reposted++;
                dupeStreak = 0;
                console.log(`[CrawlDaemon] ⤴️ 끌올 갱신: 원본 #${ref.articleId} posted_at 전진 (끌올 글 #${t.articleId}${orig && orig.sourcePrice !== null ? `, 가격 ${orig.sourcePrice}+${orig.fee}` : ', 라이트 갱신'})`);
              }
            } else {
              // 과거 끌올 재관측 — 기존 중복 의미 유지
              skipped++;
              dupeStreak++;
              console.log(`[CrawlDaemon] ⤴️ #${t.articleId} 끌어올림 (원본 #${ref.articleId} 최신 아님) — 스킵`);
            }
            // 처리 완료한 끌올 글 자체는 재진입 방지 캐시 (같은 상품의 새 끌올은 새 articleId로 옴)
            await markIgnored(t.articleId, 'link_repost_done', detail.title);
            repostHandled = true;
            break;
          }

          // 원본 미적재 → 원본 값을 이식해 아래 신규 INSERT 경로로 진행
          if (orig && orig.sourcePrice !== null) {
            detail.sourcePrice = orig.sourcePrice;
            detail.fee = orig.fee;
            detail.content = orig.content;
            if (orig.imageUrls.length > 0) detail.imageUrls = orig.imageUrls;
            if (!detail.sizes) detail.sizes = orig.sizes;
            if (!detail.colors) detail.colors = orig.colors;
            if (!detail.authorNickname) detail.authorNickname = orig.authorNickname;
            resolvedFromLink = true;
            console.log(`[CrawlDaemon] #${t.articleId} 링크 원본(#${ref.articleId})에서 가격 회수: ${orig.sourcePrice}+${orig.fee}`);
            break;
          }
        }

        if (repostHandled) {
          if (stopAfterDupes > 0 && dupeStreak >= stopAfterDupes) {
            console.log(`[CrawlDaemon] ⏹ 연속 중복 ${dupeStreak}건 — "중복 전까지" 조기 종료 (마지막 #${t.articleId})`);
            warnings.push(`연속 중복 ${dupeStreak}건으로 조기 종료 (#${t.articleId}에서 중단)`);
            break;
          }
          continue;
        }

        if (!resolvedFromLink) {
          failed++;
          warnings.push(`#${t.articleId} 가격 파싱 실패: "${detail.title.slice(0, 40)}"`);
          // 가격도 없고 끌어올림 링크도 없으면 = 출석/후기 등 비상품 글 → 영구 스킵 캐시에 등록(다음 사이클 재방문 차단).
          // 링크는 있으나 원본 회수만 실패한 경우는 일시적일 수 있어 캐시하지 않는다.
          if (linkedUrls.length === 0) {
            await markIgnored(t.articleId, 'no_price', detail.title);
            console.log(`[CrawlDaemon] 🚫 #${t.articleId} 비상품(가격·링크 없음) → 스킵 캐시 등록: "${detail.title.slice(0, 30)}"`);
          }
          continue;
        }
      }

      // 위 가드(null → continue 또는 링크 회수)로 이 지점에선 항상 숫자
      const sourcePrice = detail.sourcePrice as number;
      const dedupKey = buildDedupKey(detail.title, sourcePrice);
      const postedAt = detail.postedAt || new Date().toISOString();
      const articleUrl = `https://cafe.naver.com/f-e/cafes/${CLUB_ID}/articles/${t.articleId}`;
      const price = sourcePrice + detail.fee;
      const authorNickname = detail.authorNickname ? detail.authorNickname.trim() : null;
      const managerId = authorNickname ? managerMap.get(authorNickname) || null : null;
      const titleSoldout = detectSoldoutFromTitle(detail.title); // 제목 품절 표기 → 자동 품절

      // 최종 블록 가드 — 링크 경로에서 닉네임이 뒤늦게 채워진 경우 대비
      if (authorNickname && blockedAuthors.has(authorNickname)) {
        await markIgnored(t.articleId, 'blocked_author', detail.title);
        console.log(`[CrawlDaemon] ⛔ #${t.articleId} 블록 작성자(${authorNickname}) — 적재 직전 차단`);
        continue;
      }

      // 재게시(끌어올림) 판정
      const { data: existing, error: dupErr } = await sb
        .from('products')
        .select('id, posted_at')
        .eq('dedup_key', dedupKey)
        .maybeSingle();

      if (dupErr) {
        failed++;
        warnings.push(`#${t.articleId} dedup 조회 실패: ${dupErr.message}`);
        continue;
      }

      if (existing) {
        const prevPostedMs = existing.posted_at ? new Date(existing.posted_at).getTime() : 0;
        if (new Date(postedAt).getTime() > prevPostedMs) {
          // 끌어올림 → 기존 상품을 새 글로 갱신
          const repostUpd: Record<string, unknown> = {
            cafe_article_id: t.articleId,
            naver_article_url: articleUrl,
            posted_at: postedAt,
            is_active: true,
            source_price: sourcePrice,
            fee: detail.fee,
            price,
            content: detail.content,
            author_nickname: authorNickname,
            is_soldout: titleSoldout, // 재게시 제목 기준 품절 동기화 (표기 빠지면 해제)
          };
          // 옵션은 파싱값이 있을 때만 갱신 — 빈 값으로 어드민 수동 보정을 덮지 않음
          if (detail.sizes) repostUpd.sizes = detail.sizes;
          if (detail.colors) repostUpd.colors = detail.colors;
          const { error: upErr } = await sb
            .from('products')
            .update(repostUpd)
            .eq('id', existing.id);

          if (upErr) {
            failed++;
            warnings.push(`#${t.articleId} 재게시 UPDATE 실패: ${upErr.message}`);
            continue;
          }

          await sb.from('product_images').delete().eq('product_id', existing.id);
          if (detail.imageUrls.length > 0) {
            const { error: imgErr } = await sb.from('product_images').insert(
              detail.imageUrls.map((url, idx) => ({
                product_id: existing.id,
                image_url: url,
                display_order: idx,
              }))
            );
            if (imgErr) warnings.push(`#${t.articleId} 재게시 이미지 적재 실패: ${imgErr.message}`);
          }

          reposted++;
          dupeStreak = 0;
          console.log(`[CrawlDaemon] ♻️ 재게시 갱신: "${detail.title.slice(0, 40)}" (#${t.articleId})`);
        } else {
          skipped++;
          dupeStreak++;
          if (stopAfterDupes > 0 && dupeStreak >= stopAfterDupes) {
            console.log(`[CrawlDaemon] ⏹ 연속 중복 ${dupeStreak}건 — "중복 전까지" 조기 종료 (마지막 #${t.articleId})`);
            warnings.push(`연속 중복 ${dupeStreak}건으로 조기 종료 (#${t.articleId}에서 중단)`);
            break;
          }
        }
        continue;
      }

      // 신규 INSERT (product_code UNIQUE 충돌 시 코드 증가 재시도, dedup/article 충돌은 멱등 스킵)
      let settled = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const productCode = String(codeCursor);
        codeCursor++;

        const { data: ins, error: insErr } = await sb
          .from('products')
          .insert({
            product_code: productCode,
            title: detail.title,
            content: detail.content,
            price,
            source_price: sourcePrice,
            fee: detail.fee,
            stock_quantity: 9999,
            sizes: detail.sizes,
            colors: detail.colors,
            naver_article_url: articleUrl,
            cafe_article_id: t.articleId,
            dedup_key: dedupKey,
            posted_at: postedAt,
            manager_id: managerId,
            author_nickname: authorNickname,
            is_soldout: titleSoldout,
            is_active: true,
          })
          .select('id')
          .single();

        if (!insErr && ins) {
          if (detail.imageUrls.length > 0) {
            const { error: imgErr } = await sb.from('product_images').insert(
              detail.imageUrls.map((url, idx) => ({
                product_id: ins.id,
                image_url: url,
                display_order: idx,
              }))
            );
            if (imgErr) warnings.push(`#${t.articleId} 이미지 적재 실패: ${imgErr.message}`);
          }
          inserted++;
          dupeStreak = 0;
          settled = true;
          console.log(`[CrawlDaemon] ➕ 신규 적재: "${detail.title.slice(0, 40)}" (#${t.articleId}, 코드 ${productCode})`);
          break;
        }

        if (insErr && insErr.code === '23505') {
          const dupSource = `${insErr.message || ''} ${insErr.details || ''}`;
          if (dupSource.includes('product_code')) {
            // 상품코드 충돌 → 다음 코드로 재시도
            continue;
          }
          // cafe_article_id / dedup_key 충돌 → 이미 적재됨 (멱등)
          skipped++;
          dupeStreak++;
          settled = true;
          break;
        }

        failed++;
        settled = true;
        warnings.push(`#${t.articleId} INSERT 실패: ${insErr?.message || '알 수 없는 오류'}`);
        break;
      }

      if (!settled) {
        failed++;
        warnings.push(`#${t.articleId} product_code 충돌 3회로 INSERT 포기`);
      }

      if (stopAfterDupes > 0 && dupeStreak >= stopAfterDupes) {
        console.log(`[CrawlDaemon] ⏹ 연속 중복 ${dupeStreak}건 — "중복 전까지" 조기 종료 (마지막 #${t.articleId})`);
        warnings.push(`연속 중복 ${dupeStreak}건으로 조기 종료 (#${t.articleId}에서 중단)`);
        break;
      }
    } catch (itemErr: any) {
      failed++;
      warnings.push(`#${t.articleId} 처리 중 예외: ${String(itemErr?.message || itemErr).slice(0, 200)}`);
    }
  }

  return { scanned, inserted, reposted, skipped, failed, warnings };
}

// ---- crawl_queue 처리 ----
async function claimJob(): Promise<any | null> {
  const { data: jobs } = await sb
    .from('crawl_queue')
    .select('*')
    .eq('status', 'PENDING')
    .order('created_at', { ascending: true })
    .limit(1);
  if (!jobs || !jobs.length) return null;
  const job = jobs[0];
  // 원자적 claim: 여전히 PENDING일 때만 PROCESSING으로
  const { data: claimed } = await sb
    .from('crawl_queue')
    .update({ status: 'PROCESSING', attempts: job.attempts + 1, updated_at: new Date().toISOString() })
    .eq('id', job.id)
    .eq('status', 'PENDING')
    .select();
  return claimed && claimed.length ? claimed[0] : null;
}

async function hasActiveJob(): Promise<boolean> {
  const { data } = await sb
    .from('crawl_queue')
    .select('id')
    .in('status', ['PENDING', 'PROCESSING'])
    .limit(1);
  return !!(data && data.length);
}

async function createScheduledJob(): Promise<any | null> {
  const { data, error } = await sb
    .from('crawl_queue')
    .insert({
      status: 'PROCESSING',
      trigger_type: 'SCHEDULED',
      payload: { limit: 200 },
      attempts: 1,
    })
    .select()
    .single();
  if (error) {
    console.error('[CrawlDaemon] 스케줄 작업 생성 실패:', error.message);
    return null;
  }
  return data;
}

async function processJob(job: any) {
  console.log(`[CrawlDaemon] ▶ 크롤 작업 시작 (job ${job.id}, ${job.trigger_type}, 시도 ${job.attempts})`);
  currentJobId = job.id;
  markProgress();
  const page = await getPage();
  await withTimeout(ensureLogin(page), 180_000, 'ensureLogin');
  const limit = (job.payload && job.payload.limit) || 200;
  const stopAfterDupes = (job.payload && job.payload.stopAfterDupes) || 0;
  const result = await runCrawl(page, job.id, limit, stopAfterDupes);
  await sb
    .from('crawl_queue')
    .update({ status: 'DONE', result, error: null, updated_at: new Date().toISOString() })
    .eq('id', job.id);
  console.log(
    `[CrawlDaemon] ✅ 완료 (job ${job.id}) — scanned:${result.scanned} inserted:${result.inserted} reposted:${result.reposted} skipped:${result.skipped} failed:${result.failed}`
  );
  if (result.warnings.length > 0) {
    console.warn(`[CrawlDaemon] ⚠️ 경고 ${result.warnings.length}건:`);
    result.warnings.slice(0, 20).forEach((w) => console.warn(`  - ${w}`));
  }
}

let lastIdleBeatAt = 0; // idle 생존 신호 스로틀

async function loop() {
  console.log('[CrawlDaemon] 🟢 네이버 카페 크롤러 데몬 시작. 큐 폴링 중... (Ctrl+C 종료)');
  console.log('[CrawlDaemon] 카페 clubId:', CLUB_ID, '/ 프로필 경로:', process.env.NAVER_PROFILE_DIR);

  // 기동 직후 좀비 PROCESSING 회수 — 이전 프로세스가 hang 중 죽었어도 자동 크롤 재개 가능하게
  await recoverStaleJobs();
  startWatchdog();

  let lastScheduledAt = Date.now(); // 기동 후 10분 뒤 첫 자동 크롤

  while (true) {
    try {
      markProgress(); // idle 폴링도 진행으로 간주 (watchdog은 작업 중일 때만 무진행 판정)
      await recoverStaleJobs();

      // (A) 수동(MANUAL) 큐 작업 우선 claim
      let job = await claimJob();

      // (B) 10분 경과 시 자체 SCHEDULED 작업 생성 → 동일 process 경로 (모든 실행이 큐에 로그로 남음)
      if (!job && Date.now() - lastScheduledAt >= SCHEDULE_MS) {
        lastScheduledAt = Date.now();
        const busy = await hasActiveJob();
        if (!busy) {
          job = await createScheduledJob();
          if (job) console.log(`[CrawlDaemon] ⏰ 10분 주기 자동 크롤 작업 생성 (job ${job.id})`);
        }
      }

      if (!job) {
        // idle 상태에서도 생존 신호 (관리자 배너가 크롤러 IDLE/OFFLINE을 구분할 수 있게)
        if (Date.now() - lastIdleBeatAt >= 60_000) {
          lastIdleBeatAt = Date.now();
          await reportDaemonStatus({ name: 'crawler', state: 'IDLE', detail: { clubId: CLUB_ID } });
        }
        await sleep(POLL_MS);
        continue;
      }

      try {
        await processJob(job);
        currentJobId = null;
      } catch (e: any) {
        currentJobId = null;
        const isFinal = job.attempts >= (job.max_attempts || 3);
        await sb
          .from('crawl_queue')
          .update({
            status: isFinal ? 'FAILED' : 'PENDING',
            error: String(e?.message || e).slice(0, 500),
            updated_at: new Date().toISOString(),
          })
          .eq('id', job.id);
        if (isFinal) {
          console.error(`[CrawlDaemon] 🔴 최종 실패 (job ${job.id}): ${e?.message} — 관리자 확인 필요`);
        } else {
          console.warn(`[CrawlDaemon] 🟡 실패, 재시도 대기 (job ${job.id}, ${job.attempts}/${job.max_attempts}): ${e?.message}`);
        }
        // 브라우저 크래시 가능성 대비 — 다음 작업에서 재기동
        await resetBrowser();
      }
    } catch (loopErr: any) {
      console.error('[CrawlDaemon] 루프 오류:', loopErr?.message);
      await sleep(POLL_MS);
    }
  }
}

loop();
