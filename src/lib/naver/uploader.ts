import puppeteer, { Browser, Page } from 'puppeteer';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { uploadDiagnosticScreenshot } from './diagnostics';

interface UploadPayload {
  type?: 'NEW' | 'REPOST';
  title: string;
  content: string;
  price: number;
  productCode: string;
  imageUrls: string[];
  orderUrl: string;
  productId?: string;
}

/* ============================================================
 * 실패 진단 레코더 (2026-07-30)
 *
 * uploadToNaverCafe()는 하위호환을 위해 계속 string|null을 반환하지만(호출부 2곳),
 * 그 null이 "어느 단계에서" 왜 발생했는지를 여기에 기록해 데몬이 DB에 남길 수 있게 한다.
 *
 * 모듈 레벨 단일 슬롯이라 동시 실행되면 서로 덮어쓴다 — 포스터 데몬은 posting_queue를
 * 원자적으로 1건씩 claim해 순차 처리하므로 안전하다(naver-poster-daemon.ts의 claimJob).
 * 동시 업로드를 도입할 때는 이 구조를 반드시 함께 바꿔야 한다.
 * ============================================================ */

/** 업로드 진행 단계 — 실패 시 어디까지 갔는지 식별 */
export type UploadStage =
  | 'LOGIN'        // 네이버 로그인
  | 'CAFE_ENTER'   // 카페 글쓰기 페이지 진입 (멤버 권한 검증 포함)
  | 'BOARD_SELECT' // 게시판 선택
  | 'TITLE'        // 제목 입력
  | 'CONTENT'      // 본문 에디터 입력
  | 'IMAGE'        // 이미지 업로드
  | 'REGISTER'     // 등록 버튼 클릭
  | 'VERIFY';      // 등록 결과 URL 검증

export interface UploadDiagnostics {
  stage: UploadStage;
  /** 기계 판독용 사유 코드 */
  reason:
    | 'LOGIN_FAILED'
    | 'CAPTCHA'
    | 'DEVICE_CONFIRM'
    | 'NO_CREDENTIALS'
    | 'MEMBERSHIP'
    | 'TIMEOUT'
    | 'STILL_ON_WRITE_FORM'
    | 'EXCEPTION'
    | 'UNKNOWN';
  message: string;
  pageUrl?: string;
  pageTitle?: string;
  captcha?: boolean;
  deviceConfirm?: boolean;
  /** daemon-diagnostics 버킷 내 스크린샷 경로 */
  screenshotPath?: string | null;
  at: string;
}

let currentStage: UploadStage = 'LOGIN';
let lastDiagnostics: UploadDiagnostics | null = null;
/** loginToNaver가 감지한 캡차/기기확인 신호 (uploadToNaverCafe 실패 진단에 합류) */
let loginSignals: { captcha: boolean; deviceConfirm: boolean; note: string } = {
  captcha: false,
  deviceConfirm: false,
  note: ''
};

function setStage(stage: UploadStage) {
  currentStage = stage;
  console.log(`[Uploader] ▷ 단계: ${stage}`);
}

/** 직전 uploadToNaverCafe / ensurePosterSession 실패의 진단 정보 (없으면 null) */
export function getLastUploadDiagnostics(): UploadDiagnostics | null {
  return lastDiagnostics;
}

/** 로그인 페이지의 캡차·기기확인 흔적을 실제로 검사한다 (기존에는 감지 코드가 전무했음) */
async function inspectLoginBlockers(page: Page): Promise<{ captcha: boolean; deviceConfirm: boolean; url: string; title: string }> {
  let url = '';
  let title = '';
  let captcha = false;
  let deviceConfirm = false;
  try {
    url = page.url();
    title = await page.title().catch(() => '');
    const probe = await page.evaluate(() => {
      const hasCaptcha = !!document.querySelector('#captchaimg, #chptcha, .captcha_wrap, [id*="captcha"], [class*="captcha"]');
      const bodyText = (document.body?.innerText || '').slice(0, 3000);
      return { hasCaptcha, bodyText };
    });
    captcha = probe.hasCaptcha || /보안문자|자동입력 방지/.test(probe.bodyText);
    deviceConfirm =
      /deviceConfirm|need2|otp|sso\/finalize|nidlogin\.login/i.test(url) ||
      /새로운 기기|기기 확인|2단계 인증|본인 확인/.test(probe.bodyText);
  } catch {
    /* 페이지가 이미 닫힌 경우 등 — 감지 불가로 처리 */
  }
  return { captcha, deviceConfirm, url, title };
}

/** 실패 진단을 기록하고, 가능하면 스크린샷을 비공개 버킷에 올린다 */
async function recordDiagnostics(
  page: Page | null,
  reason: UploadDiagnostics['reason'],
  message: string,
  stage: UploadStage = currentStage
): Promise<UploadDiagnostics> {
  const diag: UploadDiagnostics = {
    stage,
    reason,
    message: String(message || '').slice(0, 1000),
    captcha: loginSignals.captcha || undefined,
    deviceConfirm: loginSignals.deviceConfirm || undefined,
    screenshotPath: null,
    at: new Date().toISOString()
  };

  if (page) {
    try {
      diag.pageUrl = page.url();
      diag.pageTitle = await page.title().catch(() => undefined);
      const buf = (await page.screenshot({ type: 'jpeg', quality: 70 })) as Buffer;
      diag.screenshotPath = await uploadDiagnosticScreenshot(buf, 'poster', `${stage}-${reason}`);
      // 업로드 실패 시 로컬 폴백 (윈도우 PC에서 직접 볼 수 있게)
      if (!diag.screenshotPath) {
        const fallback = path.join(process.cwd(), 'error_screenshot.png');
        await page.screenshot({ path: fallback }).catch(() => {});
        console.log(`[Uploader] 진단 스크린샷 로컬 폴백 저장: ${fallback}`);
      }
    } catch (ssErr: any) {
      console.warn('[Uploader] 진단 스크린샷 처리 실패:', ssErr?.message || ssErr);
    }
  }

  lastDiagnostics = diag;
  console.error(
    `[Uploader] ❌ 진단 기록 — stage=${diag.stage} reason=${diag.reason}` +
      `${diag.captcha ? ' captcha=true' : ''}${diag.deviceConfirm ? ' deviceConfirm=true' : ''} url=${diag.pageUrl || '-'}`
  );
  return diag;
}

/** 사람이 읽을 한 줄 요약 (posting_queue.error에 저장됨) */
export function describeDiagnostics(diag: UploadDiagnostics | null): string {
  if (!diag) return '포스팅 결과 URL을 받지 못함 (진단 정보 없음)';
  const stageLabel: Record<UploadStage, string> = {
    LOGIN: '네이버 로그인',
    CAFE_ENTER: '카페 글쓰기 진입',
    BOARD_SELECT: '게시판 선택',
    TITLE: '제목 입력',
    CONTENT: '본문 입력',
    IMAGE: '이미지 업로드',
    REGISTER: '등록 버튼',
    VERIFY: '등록 결과 검증'
  };
  const extra = diag.deviceConfirm ? ' — 기기확인/2단계 인증 화면 감지' : diag.captcha ? ' — 캡차(보안문자) 감지' : '';
  return `${stageLabel[diag.stage]} 단계 실패${extra}: ${diag.message}`.slice(0, 500);
}

/** 로그인 단계 실패인지 (재시도해도 무의미 → 데몬이 즉시 중단 판단에 사용) */
export function isLoginBlocked(diag: UploadDiagnostics | null): boolean {
  if (!diag) return false;
  return (
    diag.stage === 'LOGIN' ||
    diag.reason === 'LOGIN_FAILED' ||
    diag.reason === 'CAPTCHA' ||
    diag.reason === 'DEVICE_CONFIRM' ||
    diag.reason === 'NO_CREDENTIALS' ||
    !!diag.captcha ||
    !!diag.deviceConfirm
  );
}

/**
 * URL 이미지들을 로컬 임시 디렉토리에 다운로드합니다.
 * Puppeteer 파일 업로드 시 로컬 절대 경로가 필요하기 때문입니다.
 */
async function downloadImagesToLocal(imageUrls: string[], productCode?: string): Promise<string[]> {
  const localPaths: string[] = [];
  const tempDir = path.join(process.cwd(), 'temp_uploads');

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // 충돌 방지를 위해 파일명에 들어갈 유니크 해시 생성
  const uniquePrefix = `temp_img_${productCode || 'prod'}_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`;

  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];

    // 1) Base64 데이터 URL 처리
    if (url.startsWith('data:image/')) {
      try {
        const matches = url.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
        if (matches) {
          const rawExt = matches[1];
          const ext = '.' + (rawExt === 'jpeg' ? 'jpg' : rawExt.split('+')[0]); // svg+xml 등 대응
          const base64Data = matches[2];
          const buffer = Buffer.from(base64Data, 'base64');
          const filePath = path.join(tempDir, `${uniquePrefix}_${i}${ext}`);

          fs.writeFileSync(filePath, buffer);
          localPaths.push(filePath);
          console.log(`[Uploader] Base64 데이터를 로컬 파일로 디코딩 완료: ${filePath}`);
          continue;
        }
      } catch (base64Err) {
        console.error(`[Uploader] Base64 데이터 파싱 중 오류 발생:`, base64Err);
      }
    }

    // 2) 일반 HTTP/HTTPS URL 다운로드
    try {
      const ext = path.extname(new URL(url).pathname) || '.jpg';
      const filePath = path.join(tempDir, `${uniquePrefix}_${i}${ext}`);

      const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
      });

      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);

      await new Promise<void>((resolve, reject) => {
        writer.on('finish', () => resolve());
        writer.on('error', reject);
      });

      localPaths.push(filePath);
    } catch (err) {
      console.error(`[Uploader] 이미지 다운로드 실패 (${url.slice(0, 80)}...):`, err);
    }
  }

  return localPaths;
}

/**
 * 로컬 임시 다운로드 이미지들을 청소합니다.
 */
function cleanLocalTempImages(paths: string[]) {
  paths.forEach((p) => {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  });
}

/**
 * 2차 인증이 해제된 스탭 부계정으로 네이버에 로그인합니다.
 * 캡차 차단을 피하기 위해 타이핑 딜레이 및 인풋 필드 주입을 정교하게 제어합니다.
 */
export async function loginToNaver(page: Page): Promise<boolean> {
  const username = process.env.NAVER_USER_ID || '';
  const password = process.env.NAVER_USER_PW || '';

  // 이번 로그인 시도의 차단 신호 초기화
  loginSignals = { captcha: false, deviceConfirm: false, note: '' };

  if (!username || !password) {
    console.error('[Uploader] 네이버 로그인 환경변수(NAVER_USER_ID, NAVER_USER_PW)가 누락되었습니다.');
    loginSignals.note = 'NO_CREDENTIALS';
    return false;
  }

  // 영속 프로필(userDataDir)로 이미 로그인된 세션이 있으면 재로그인 생략
  try {
    await page.goto('https://www.naver.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    const existing = await page.cookies();
    if (existing.some((c) => c.name === 'NID_SES' || c.name === 'NID_AUT')) {
      console.log('[Uploader] 기존 네이버 세션 감지 — 재로그인 생략.');
      return true;
    }
  } catch (e) {
    console.log('[Uploader] 세션 사전확인 스킵, 로그인 진행.');
  }

  console.log('[Uploader] 네이버 로그인 페이지 이동 중...');
  await page.goto('https://nid.naver.com/nidlogin.login', { waitUntil: 'domcontentloaded' });
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log('[Uploader] 네이버 계정 정보 자동 입력 중...');
  // 네이버의 캡차 보안 차단을 피하기 위해 evaluate를 통해 인풋 벨류를 다이렉트로 설정
  await page.evaluate((u, p) => {
    const idInput = document.querySelector('#id') as HTMLInputElement;
    const pwInput = document.querySelector('#pw') as HTMLInputElement;
    if (idInput && pwInput) {
      idInput.value = u;
      pwInput.value = p;
    }
  }, username, password);

  await new Promise((resolve) => setTimeout(resolve, 1000));
  
  // 로그인 버튼 클릭
  // 네이버가 로그인 폼을 반응형으로 개편해(2026-07-30 확인) 기존 #log.login / .btn_login이 모두
  // 사라졌다. 현재는 #loginBtn_row(넓은 화면 표시)와 #loginBtn_column(좁은 화면 표시)이 공존하고,
  // 클래스 .btn_done은 패스키 로그인 버튼(#passkeyBtn_row/_column)도 함께 쓰므로 클래스로 잡으면
  // 패스키를 눌러버린다. id 접두어로 한정한 뒤 실제로 보이는 것을 고른다.
  // 클릭은 JS .click()이 아닌 Puppeteer 물리 클릭으로 — 네이버가 isTrusted를 볼 여지를 남기지 않는다.
  const loginBtnId = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('button[id^="loginBtn"]')) as HTMLElement[];
    const target = els.find((el) => el.getBoundingClientRect().height > 0) || els[0];
    return target ? target.id : null;
  });

  if (loginBtnId) {
    await page.click(`#${loginBtnId}`);
  } else {
    // 레거시 마크업 폴백 (구 로그인 페이지가 남아있는 경우)
    const legacyBtn = (await page.$('#log\\.login')) || (await page.$('.btn_login'));
    if (!legacyBtn) {
      throw new Error(
        '로그인 버튼을 찾지 못했습니다 — 네이버 로그인 폼 마크업이 또 변경된 것으로 보입니다 ' +
          '(기대: button[id^="loginBtn"] 또는 레거시 #log.login/.btn_login)'
      );
    }
    await legacyBtn.click();
  }

  // 로그인 성공 후 페이지 렌더링을 기다립니다.
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {
    console.log('[Uploader] 페이지 내비게이션 대기 타임아웃. 세션을 계속 진행합니다.');
  });

  // 쿠키 확인 등으로 로그인 검증
  const cookies = await page.cookies();
  const isLoggedIn = cookies.some((c) => c.name === 'NID_SES' || c.name === 'NID_AUT');

  if (isLoggedIn) {
    console.log('[Uploader] 네이버 로그인 성공!');
    return true;
  }

  // 실패 원인을 추측 문구로 남기지 않고 실제 화면을 검사한다 (캡차/기기확인 감지)
  const blockers = await inspectLoginBlockers(page);
  loginSignals.captcha = blockers.captcha;
  loginSignals.deviceConfirm = blockers.deviceConfirm;
  loginSignals.note = blockers.captcha
    ? 'CAPTCHA'
    : blockers.deviceConfirm
      ? 'DEVICE_CONFIRM'
      : 'LOGIN_FAILED';
  console.error(
    `[Uploader] 네이버 로그인 실패 — captcha=${blockers.captcha} deviceConfirm=${blockers.deviceConfirm} ` +
      `url=${blockers.url} title="${blockers.title}"`
  );
  return false;
}

/**
 * 작업용 탭 하나만 남기고 전부 닫는다 (2026-07-30).
 *
 * userDataDir로 크롬 프로필을 영속화하는데(로그인 세션 유지 목적), 데몬이 비정상 종료되면
 * (크래시 / taskkill / 래퍼의 강제 재시작) 크롬이 정상 종료 플래그를 남기지 못해 다음 실행에서
 * 세션 복원이 이전 탭을 전부 되살린다. 여기에 newPage()가 매번 하나씩 더 얹혀 탭이 무한 누적된다.
 * 쿠키는 탭과 무관하므로 이렇게 정리해도 로그인 세션은 유지된다.
 */
async function closeOtherTabs(browser: Browser, keep: Page) {
  for (const p of await browser.pages()) {
    if (p !== keep) await p.close().catch(() => {});
  }
}

/**
 * esbuild `keepNames` 헬퍼(`__name`) 폴리필 (2026-07-30).
 *
 * page.evaluate는 콜백을 문자열로 직렬화해 브라우저에서 실행한다. 그런데 tsx(esbuild)는
 * 이름 붙은 함수를 `__name(fn, "이름")`으로 감싸고 `__name`은 Node 모듈 프렐류드에만 정의되므로,
 * evaluate 안에 이름 붙은 함수가 있으면 브라우저에서 ReferenceError가 난다.
 * 원본 fac는 SWC로 빌드돼 재현되지 않고 tsx로 도는 이 데몬에서만 터지므로 놓치기 쉽다.
 *
 * 인자를 문자열로 넘기는 것이 핵심 — 함수로 넘기면 이 shim 자체가 트랜스파일 대상이 된다.
 */
async function installNameShim(page: Page) {
  await page
    .evaluateOnNewDocument(
      'if (typeof __name === "undefined") { window.__name = function (f) { return f; }; }'
    )
    .catch(() => {});
}

/**
 * 재업 대상 게시판 결정 — 원본 글이 있던 게시판을 그대로 쓴다 (2026-07-30).
 *
 * 배경: 기존에는 '자유게시판'을 텍스트로 찾고, 실패하면 드롭다운 목록에서 필터를 통과한
 * "첫 번째 항목"을 그냥 집는 자가치유 폴백이 돌았다. 게시판이 몇 개뿐인 테스트 카페에서는
 * 우연히 맞았지만, 게시판이 많은 실카페(28310071)에서는 사실상 무작위라 상품 재업글이
 * '🗂계좌정보>핫딜매니저' 게시판에 등록되는 사고가 났다.
 *
 * 재업은 원래 그 상품을 수집해온 게시판으로 되돌아가는 것이 맞다. 크롤러가 게시판을 별도
 * 컬럼으로 저장하지 않으므로, products.naver_article_url(원본 글)을 열어 게시판명을 읽는다.
 * 읽지 못하면 null을 반환하고, 호출부는 글을 쓰지 않고 실패시킨다.
 */
async function resolveTargetBoardName(page: Page, productId?: string): Promise<string | null> {
  if (!productId) {
    console.error('[Uploader] payload.productId가 없어 원본 게시판을 확인할 수 없습니다.');
    return null;
  }

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !supaKey) {
    console.error('[Uploader] Supabase 환경변수 누락 — 원본 게시판 확인 불가.');
    return null;
  }

  const sb = createClient(supaUrl, supaKey, { auth: { persistSession: false } });
  const { data, error } = await sb
    .from('products')
    .select('naver_article_url')
    .eq('id', productId)
    .maybeSingle();

  const articleUrl = data?.naver_article_url as string | undefined;
  if (error || !articleUrl) {
    console.error(`[Uploader] 원본 글 URL 조회 실패: ${error?.message || '값 없음'}`);
    return null;
  }

  // naver_article_url은 두 형식이 섞여 있다:
  //   크롤러 적재분 → https://cafe.naver.com/f-e/cafes/{cafeId}/articles/{id}      (PC)
  //   포스터 갱신분 → https://m.cafe.naver.com/ca-fe/web/cafes/{cafeId}/articles/{id}?tc (모바일)
  // 게시판명을 읽는 .tit_menu는 모바일 페이지에만 있으므로 항상 모바일 형식으로 정규화한다.
  const ids = articleUrl.match(/cafes\/(\d+)\/articles\/(\d+)/);
  if (!ids) {
    console.error(`[Uploader] 원본 글 URL에서 카페/글 ID를 파싱하지 못했습니다: ${articleUrl}`);
    return null;
  }
  const mobileUrl = `https://m.cafe.naver.com/ca-fe/web/cafes/${ids[1]}/articles/${ids[2]}`;

  console.log(`[Uploader] 원본 글에서 게시판 확인 중: ${mobileUrl}`);
  try {
    await page.goto(mobileUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const name = await page.evaluate(() => {
      const el = document.querySelector('.tit_menu');
      if (!el) return null;
      // .tit_menu 텍스트는 "실시간>프랜치캣.게스.티파니.엘리콘앱 열기" 처럼 끝에 '앱 열기'가 붙는다.
      // 게시판명 자체가 <a> 안에 들어있으므로 a/button을 지우면 이름까지 날아간다 — 꼬리만 떼어낸다.
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const cleaned = text.replace(/앱\s*열기\s*$/, '').trim();
      return cleaned || null;
    });

    if (!name) {
      console.error('[Uploader] 원본 글에서 게시판명을 찾지 못했습니다 (.tit_menu 매칭 실패).');
      return null;
    }
    console.log(`[Uploader] 원본 게시판 확인: "${name}"`);
    return name;
  } catch (err: any) {
    console.error(`[Uploader] 원본 글 열기 실패: ${err?.message || err}`);
    return null;
  }
}

/**
 * 세션 워밍업 (2026-07-30) — 포스터 데몬이 재업 작업 없이도 주기적으로 호출한다.
 *
 * 배경: 포스터는 작업이 있을 때만 브라우저를 띄우므로(크롤러는 10분마다 상시 접속) 세션이
 * 오래 방치되면 네이버가 기기확인/캡차를 요구한다. 실제 재업 요청이 들어온 순간에야 그 사실을
 * 알게 되어 주문 대응이 늦어졌다. 주기적으로 세션을 갱신하고, 깨졌으면 미리 알린다.
 */
export async function ensurePosterSession(): Promise<{ ok: boolean; diagnostics: UploadDiagnostics | null }> {
  lastDiagnostics = null;
  setStage('LOGIN');

  const browser = await puppeteer.launch({
    headless: process.env.NAVER_HEADLESS === 'false' ? false : true,
    protocolTimeout: 120_000,
    userDataDir: process.env.NAVER_PROFILE_DIR || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1280,1024',
      '--disable-blink-features=AutomationControlled',
      // 프로필 영속화 + 비정상 종료 조합에서 뜨는 "복원하시겠습니까?" 버블이 클릭을 가로채는 것 방지
      '--hide-crash-restore-bubble',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  let page: Page | null = null;
  try {
    page = await browser.newPage();
    await closeOtherTabs(browser, page);
    await installNameShim(page);
    await page.setViewport({ width: 1280, height: 1024 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    const ok = await loginToNaver(page);
    if (!ok) {
      const reason: UploadDiagnostics['reason'] =
        loginSignals.note === 'CAPTCHA' ? 'CAPTCHA'
        : loginSignals.note === 'DEVICE_CONFIRM' ? 'DEVICE_CONFIRM'
        : loginSignals.note === 'NO_CREDENTIALS' ? 'NO_CREDENTIALS'
        : 'LOGIN_FAILED';
      const diag = await recordDiagnostics(page, reason, '세션 점검 중 로그인 실패 — 수동 재로그인이 필요합니다.', 'LOGIN');
      return { ok: false, diagnostics: diag };
    }

    console.log('[Uploader] ✅ 포스터 세션 정상 (주기 점검 통과)');
    return { ok: true, diagnostics: null };
  } catch (err: any) {
    const diag = await recordDiagnostics(page, 'EXCEPTION', `세션 점검 예외: ${err?.message || err}`, 'LOGIN');
    return { ok: false, diagnostics: diag };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * 🛠️ 네이버 카페 글쓰기 자동 포스팅 엔진
 */
export async function uploadToNaverCafe(payload: UploadPayload): Promise<string | null> {
  // 포스팅 대상 카페 (env 전환): 기본값은 테스트 카페(31729221, 이혁의카페).
  // 실카페 전환 시 윈도우 .env.local에 NAVER_POST_CAFE_ID=28310071 한 줄 추가.
  const targetCafeId = process.env.NAVER_POST_CAFE_ID || '31729221';
  
  // 🚨 [위임 모드 기동 가드] 만약 NAVER_POSTER_PROXY_URL 설정이 활성화되어 있다면 로컬 데몬 서버로 위임!
  const proxyUrl = process.env.NAVER_POSTER_PROXY_URL;
  if (proxyUrl) {
    console.log(`[Uploader] 📡 네이버 포스팅 외부 위임 모드 활성화됨. Target Proxy: ${proxyUrl}`);
    const daemonSecret = process.env.NAVER_DAEMON_SECRET;
    if (!daemonSecret) {
      console.error('[Uploader] NAVER_DAEMON_SECRET 환경변수가 미설정됨');
      return null;
    }
    try {
      const res = await axios.post(`${proxyUrl}/api/delegate-post`, {
        secret: daemonSecret,
        productId: payload.productId || '',
        title: payload.title,
        content: payload.content,
        price: payload.price,
        productCode: payload.productCode,
        imageUrls: payload.imageUrls || [],
        orderUrl: payload.orderUrl
      }, {
        timeout: 8000 // 데몬이 비동기 수신 응답(202)하므로 8초 타임아웃 지정
      });

      if (res.status === 202 || (res.data && res.data.success)) {
        console.log(`[Uploader] 🚀 로컬 포스팅 데몬으로 안전하게 위임 태스크 전송을 성공했습니다!`);
        return 'DELEGATED_TO_DAEMON';
      }
    } catch (proxyErr: any) {
      console.error(`[Uploader] ❌ 포스팅 데몬 위임 호출 실패. 자체 로컬 Puppeteer 기동으로 폴백합니다:`, proxyErr.message);
    }
  }

  console.log(`[Uploader] 카페 자동 포스팅 시작: ${payload.title}`);

  // 이번 시도의 진단 슬롯 초기화 (데몬이 실패 후 getLastUploadDiagnostics()로 읽는다)
  lastDiagnostics = null;
  setStage('LOGIN');

  // 1) 로컬에 이미지 다운로드
  const localImagePaths = await downloadImagesToLocal(payload.imageUrls, payload.productCode);
  
  const browser = await puppeteer.launch({
    // NAVER_HEADLESS=false 면 창 표시 — 새 기기 첫 로그인 캡차/기기확인을 눈으로 처리할 때 사용
    headless: process.env.NAVER_HEADLESS === 'false' ? false : true,
    // CDP 응답 무한 대기를 에러로 전환 (크롤러 데몬과 동일한 hang 방어)
    protocolTimeout: 120_000,
    // NAVER_PROFILE_DIR 지정 시 크롬 프로필을 영속화 → 네이버 로그인 세션 유지(매번 재로그인 방지)
    userDataDir: process.env.NAVER_PROFILE_DIR || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1280,1024',
      '--disable-blink-features=AutomationControlled',
      // 프로필 영속화 + 비정상 종료 조합에서 뜨는 "복원하시겠습니까?" 버블이 클릭을 가로채는 것 방지
      '--hide-crash-restore-bubble',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  let page: Page | null = null;
  try {
    page = await browser.newPage();
    await closeOtherTabs(browser, page);
    await installNameShim(page);
    await page.setViewport({ width: 1280, height: 1024 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // 🚨 다이얼로그 실시간 감지 및 멤버 권한 오류 캐쳐 장착
    let hasMembershipError = false;
    let membershipErrorMsg = '';
    page.on('dialog', async (dialog) => {
      const msg = dialog.message();
      console.log(`[Uploader Dialog] 알림 감지: "${msg}" (Type: ${dialog.type()})`);
      if (msg.includes('멤버만') || msg.includes('가입') || msg.includes('권한') || msg.includes('탈퇴')) {
        hasMembershipError = true;
        membershipErrorMsg = msg;
        await dialog.dismiss().catch(() => {});
      } else if (dialog.type() === 'confirm' || msg.includes('등록하시겠습니까') || msg.includes('게시글을 등록') || msg.includes('올리시겠습니까')) {
        console.log(`[Uploader Dialog] 글 등록 컨펌 자동 승인 처리 (accept)`);
        await dialog.accept().catch(() => {});
      } else {
        await dialog.dismiss().catch(() => {});
      }
    });

    // 2) 네이버 로그인
    const loggedIn = await loginToNaver(page);
    if (!loggedIn) {
      // 기존에는 로그 한 줄 없이 null만 반환해 원인 파악이 불가능했다 (2026-07-30 장애)
      const reason: UploadDiagnostics['reason'] =
        loginSignals.note === 'CAPTCHA' ? 'CAPTCHA'
        : loginSignals.note === 'DEVICE_CONFIRM' ? 'DEVICE_CONFIRM'
        : loginSignals.note === 'NO_CREDENTIALS' ? 'NO_CREDENTIALS'
        : 'LOGIN_FAILED';
      await recordDiagnostics(page, reason, '네이버 로그인에 실패했습니다. 창을 띄워(NAVER_HEADLESS=false) 수동 로그인이 필요합니다.', 'LOGIN');
      return null; // 정리(이미지 삭제 + 브라우저 종료)는 finally에서 일괄 처리
    }

    // 2-1) 대상 게시판 확정 — 글쓰기 폼에 들어가기 전에 원본 글에서 읽어온다.
    //      확정하지 못하면 여기서 중단한다. 엉뚱한 게시판에 상품글을 올리는 것보다
    //      실패로 남겨 관리자가 확인하는 편이 낫다. (2026-07-30 오게시 사고 대응)
    const targetBoardName = await resolveTargetBoardName(page, payload.productId);
    if (!targetBoardName) {
      throw new Error(
        '원본 게시판을 확정하지 못해 등록을 중단했습니다. ' +
          '(products.naver_article_url로 원본 글을 열어 게시판명을 읽지 못함) — ' +
          '임의의 게시판에 올리지 않기 위한 의도적 중단입니다.'
      );
    }

    // 3) 모바일 글쓰기 페이지로 이동 (iframe 우회를 위해 모바일 버전 글쓰기 폼 활용)
    setStage('CAFE_ENTER');
    const writeUrl = `https://m.cafe.naver.com/ca-fe/web/cafes/${targetCafeId}/articles/write`;
    console.log(`[Uploader] 카페 글쓰기 페이지 이동 중: ${writeUrl}`);
    await page.goto(writeUrl, { waitUntil: 'domcontentloaded' });
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // 🚨 멤버 권한 에러 여부 1차 검증
    if (hasMembershipError) {
      throw new Error(`네이버 카페 가입 권한 에러: "${membershipErrorMsg}". 계정이 카페의 멤버로 가입 및 승인 완료되었는지 확인해 주세요.`);
    }

    // 🚨 모바일 페이지 내 알 수 없는 오류 또는 권한 텍스트 2차 검증
    const pageHtml = await page.content();
    if (pageHtml.includes('알 수 없는 오류가 발생했습니다') || pageHtml.includes('멤버만 들어갈 수 있는') || pageHtml.includes('멤버만 들어갈 수')) {
      throw new Error('네이버 카페 가입 권한 에러: 해당 계정이 카페 멤버가 아니거나 글쓰기 권한이 없습니다.');
    }

    // 4) 글쓰기 폼 세팅
    console.log('[Uploader] 제목 및 본문 템플릿 입력 중...');

    // 🚨 게시판 선택 로직 개선 (물리 클릭 및 드롭다운 오픈 락인 가드 & 자가치유 폴백 패턴 완벽 주입)
    setStage('BOARD_SELECT');
    console.log('[Uploader] 게시판 선택 영역 활성화 시도 중...');
    const selectBoxSelector = '.selectbox, [class*="selectbox"]';
    await page.waitForSelector(selectBoxSelector, { timeout: 10000 });
    
    // 1) 물리 클릭 및 터치 타겟 전개
    let dropdownOpened = false;
    for (let clickRetry = 1; clickRetry <= 3; clickRetry++) {
      console.log(`[Uploader] 게시판 선택박스 물리 클릭 시도 (${clickRetry}회차)...`);
      await page.click(selectBoxSelector).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1500));
      
      // 드롭다운이 실제로 열려 레이어(.select_board, .LayerPopup, .BasicLayer, .list_board)가 노출되었는지 확인
      const isLayerVisible = await page.evaluate(() => {
        const boardLayer = document.querySelector('.select_board, .LayerPopup, .BasicLayer, .list_board, [class*="Popup"], [class*="Layer"]');
        if (!boardLayer) return false;
        const style = window.getComputedStyle(boardLayer);
        return style.display !== 'none' && style.visibility !== 'hidden';
      });

      if (isLayerVisible) {
        dropdownOpened = true;
        console.log('[Uploader] 게시판 선택 드롭다운 레이어 노출 확인 완료.');
        break;
      }
      
      // 백업으로 터치/탭 및 직접 JS 이벤트 시뮬레이션
      console.warn('[Uploader] 레이어 미노출. page.tap() 및 JS Click 강제 주입 기동.');
      await page.tap(selectBoxSelector).catch(() => {});
      await page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement;
        if (el) {
          el.focus();
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
      }, selectBoxSelector);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    if (!dropdownOpened) {
      console.warn('[Uploader] 물리 클릭으로 드롭다운 오픈 실패. 최종 JS dispatchEvent 백업 가동.');
      await page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement;
        if (el) {
          el.focus();
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        }
      }, selectBoxSelector);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    // 2) 원본 게시판을 "정확 일치"로만 탐색한다.
    //    부분일치나 "목록의 첫 항목" 폴백은 절대 쓰지 않는다 — 실카페에서 상품 재업글이
    //    '🗂계좌정보>핫딜매니저' 게시판에 등록된 사고의 원인이 바로 그 자가치유 폴백이었다.
    //    못 찾으면 글을 쓰지 않고 실패시킨다. (2026-07-30)
    console.log(`[Uploader] 원본 게시판 "${targetBoardName}" 탐색 중...`);

    const boardClicked = await page.evaluate((wanted) => {
      const norm = (s: string) => (s || '').replace(/\s+/g, ' ').trim();
      const want = norm(wanted);

      // 텍스트가 "정확히" 일치하고 화면에 보이는 요소를 모은다.
      // 말단 요소만 보면 안 된다 — 드롭다운 항목은 <li><span>게시판명</span></li> 처럼
      // 자식을 가진 li로 렌더되기도 한다. 정확 일치를 요구하므로 상위 컨테이너 오탐은 생기지 않고,
      // 그중 가장 깊은(자손이 가장 적은) 요소를 눌러 실제 클릭 타겟을 맞춘다.
      const candidates = (Array.from(document.querySelectorAll('*')) as HTMLElement[]).filter((el) => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return norm(el.textContent || '') === want;
      });

      candidates.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
      const el = candidates[0];
      if (!el) return { success: false, name: '', x: 0, y: 0 };

      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();

      el.click();
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

      const parentLi = el.closest('li');
      if (parentLi) {
        parentLi.click();
        parentLi.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      }

      return {
        success: true,
        name: norm(el.textContent || ''),
        x: r.left + r.width / 2,
        y: r.top + r.height / 2
      };
    }, targetBoardName);

    if (!boardClicked.success) {
      throw new Error(
        `대상 게시판을 찾지 못했습니다: "${targetBoardName}" — 임의의 게시판에 올리지 않기 위해 등록을 중단합니다. ` +
          '(원본 글의 게시판이 이 카페에 없거나 이름이 바뀐 경우)'
      );
    }

    if (boardClicked.x > 0 && boardClicked.y > 0) {
      console.log(`[Uploader] 게시판 '${boardClicked.name}' 물리 좌표 터치: x=${boardClicked.x}, y=${boardClicked.y}`);
      await page.mouse.click(boardClicked.x, boardClicked.y).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    // 3) 선택 결과 검증 — 클릭이 먹지 않아 다른 게시판인 채로 등록되는 것을 막는다
    const selectedLabel = await page.evaluate((sel) => {
      const box = document.querySelector(sel);
      return box ? (box.textContent || '').replace(/\s+/g, ' ').trim() : '';
    }, selectBoxSelector);

    if (!selectedLabel.includes(targetBoardName)) {
      throw new Error(
        `게시판 선택이 반영되지 않았습니다. 기대: "${targetBoardName}", 현재 선택박스: "${selectedLabel.slice(0, 120)}" — ` +
          '잘못된 게시판에 등록되는 것을 막기 위해 중단합니다.'
      );
    }

    console.log(`[Uploader] 게시판 자동 선택 완료 (선택 게시판: ${boardClicked.name})`);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 모바일 글쓰기 제목 셀렉터 찾기 (Vue 컴포넌트인 textarea[placeholder="제목"] 우선 적용)
    setStage('TITLE');
    const titleSelector = 'textarea[placeholder="제목"], .ArticleWriteFormSubject textarea, .input_title, input#subject';
    await page.waitForSelector(titleSelector, { timeout: 10000 });
    await page.click(titleSelector);
    
    // 제목 입력 (기획안 사양에 맞게 제목에 [실시간 핫딜] 또는 상품 번호 템플릿화)
    // 🚨 네이버 카페 모바일 제목 글자수 제한(100자)을 초과하지 않도록 안전 장치 적용
    let displayTitle = payload.title;
    if (displayTitle.length > 95) {
      displayTitle = displayTitle.slice(0, 95) + '...';
    }
    await page.type(titleSelector, displayTitle, { delay: 50 });
    await new Promise((resolve) => setTimeout(resolve, 1000)); // 제목 입력 동기화 대기

    // 확실하게 제목 창 포커스 해제 처리
    await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      if (el) el.blur();
    }, titleSelector);

    // 재업은 판매자가 작성한 원문만 유지한다. 상품번호·주문 링크 등 쇼핑몰 자동 문구는 신규 포스팅에만 사용한다.
    const formattedContent = payload.type === 'REPOST'
      ? payload.content.trim()
      : `[상품번호: ${payload.productCode}]

${payload.content}

--------------------------------------------------
🛍️ [팩토리 구매대행] 고유 주문서 안내
본 상품은 한정 재고 핫딜로 실시간 품절될 수 있습니다.

📌 상품 고유 번호: #${payload.productCode}
🔗 실시간 주문/장바구니 링크: ${payload.orderUrl}
--------------------------------------------------
※ 마음에 드는 상품은 장바구니에 모아 한 번에 결제가 가능합니다.
`;

    // 본문 에디터 영역 셀렉터 (스마트에디터 ONE 모바일용 contenteditable 캔버스 우선)
    // 🚨 덤프 분석을 통해 확인된 __se-scroll-target 내부의 contenteditable을 최우선 매칭하여 제목과의 겹침 오염 차단
    setStage('CONTENT');
    const contentSelector = '.__se-scroll-target [contenteditable="true"], .se-content [contenteditable="true"], .se-canvas [contenteditable="true"], #one-editor [contenteditable="true"], .textarea_content, textarea#content';
    await page.waitForSelector(contentSelector, { timeout: 10000 });
    
    // 🚨 안전 장치: 매칭된 본문 엘리먼트가 실제로 제목 textarea 혹은 제목과 겹치는지 엄격히 2차 검증
    const isOverlappedWithTitle = await page.evaluate((sel, tSel) => {
      const contentEl = document.querySelector(sel);
      const titleEl = document.querySelector(tSel);
      if (!contentEl) return true;
      if (contentEl === titleEl) return true;
      if (contentEl.getAttribute('placeholder') === '제목' || contentEl.tagName === 'TEXTAREA') return true;
      return false;
    }, contentSelector, titleSelector);

    if (isOverlappedWithTitle) {
      console.warn('[Uploader] 본문 셀렉터가 제목 엘리먼트와 오겹침 감지! 강제 자가 치유 셀렉터 탐색 진행...');
    }

    // 🚨 Selection API 캐럿 강제 이동 및 포커스 동적 가드 작동 (제목 겹침 오염 완벽 격파)
    console.log('[Uploader] 본문 Selection API 캐럿 강제 주입 및 포커스 가드 기동...');
    let focused = false;
    for (let retry = 1; retry <= 3; retry++) {
      await page.evaluate((sel, tSel) => {
        const contentEl = document.querySelector(sel) as HTMLElement;
        const titleEl = document.querySelector(tSel) as HTMLElement;
        
        if (contentEl) {
          // 제목이 activeElement라면 확실히 blur 처리하여 키보드 입력을 밀어냄
          if (document.activeElement === titleEl) {
            titleEl.blur();
          }

          contentEl.focus();

          const selection = window.getSelection();
          if (selection) {
            const range = document.createRange();
            
            // contenteditable 내부에 p, span 등 자식이 있다면 그 자식의 텍스트 영역을 타겟팅하여 캐럿 주입
            // 스마트에디터 ONE의 경우 contenteditable 바로 하위의 첫 번째 노드 또는 텍스트 컨테이너가 핵심임
            const targetChild = contentEl.querySelector('p, span') || contentEl.firstChild || contentEl;
            
            try {
              range.selectNodeContents(targetChild);
              range.collapse(false); // 캐럿을 끝으로 강제 락
              selection.removeAllRanges();
              selection.addRange(range);
            } catch (rangeErr) {
              console.error('[Uploader Eval] Range 주입 시도 중 에러:', rangeErr);
            }
          }

          // 물리/논리 클릭 및 마우스 다운 이벤트 강제 유입 시뮬레이션
          contentEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          contentEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          contentEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        }
      }, contentSelector, titleSelector);

      await new Promise((resolve) => setTimeout(resolve, 1200));

      const activeInfo = await page.evaluate((tSel) => {
        const ae = document.activeElement;
        const titleEl = document.querySelector(tSel);
        if (!ae) return { ok: false, desc: 'none' };
        
        const isTitleActive = ae === titleEl || ae.tagName === 'TEXTAREA' || ae.getAttribute('placeholder') === '제목';
        const isContentActive = ae.getAttribute('contenteditable') === 'true' || ae.closest('[contenteditable="true"]') !== null;
        
        return {
          ok: !isTitleActive && isContentActive,
          tagName: ae.tagName,
          className: ae.className,
          placeholder: ae.getAttribute('placeholder'),
          isContentEditable: ae.getAttribute('contenteditable') === 'true'
        };
      }, titleSelector);

      console.log(`[Uploader] 포커스 가드 시도 ${retry}회차 활성 엘리먼트 상태:`, activeInfo);
      if (activeInfo.ok) {
        focused = true;
        break;
      }
    }

    if (!focused) {
      console.warn('[Uploader] Selection API 강제 포커싱 3회 시도 후에도 포커스 락인 미완료. 최후 수단으로 물리 마우스 클릭 단행.');
      const contentRect = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, contentSelector);
      
      if (contentRect) {
        await page.mouse.click(contentRect.x, contentRect.y);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }

    // 🚨 [하이브리드 직접 주입 패턴] 본문 숫자 및 텍스트 씹힘 방지 보완 기동
    console.log('[Uploader] 본문 씹힘 방지를 위한 하이브리드 HTML/Text 직접 주입 시작...');
    // 1) 텍스트를 스마트에디터 표준 문단 형식(p > span)의 HTML로 변환
    //    변환은 반드시 Node 쪽에서 끝낸다 — page.evaluate 안에 이름 붙은 함수(escapeHtml)를 두면
    //    tsx(esbuild keepNames)가 __name(...)으로 감싸는데, evaluate 콜백은 문자열로 직렬화돼
    //    브라우저에서 실행되므로 __name이 없어 "__name is not defined"로 본문 단계가 통째로
    //    실패한다. 원본 fac는 SWC라 재현되지 않아 놓치기 쉽다. (2026-07-30 장애)
    const escapeHtml = (text: string) =>
      text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

    const PARA_OPEN = '<p class="se-text-paragraph se-text-paragraph-align-left">';
    const htmlContent = formattedContent
      .split('\n')
      .map((line) =>
        line.trim() === ''
          ? `${PARA_OPEN}<span><br></span></p>`
          : `${PARA_OPEN}<span>${escapeHtml(line)}</span></p>`
      )
      .join('');

    // 2) 완성된 HTML 문자열만 브라우저로 넘겨 주입 + 에디터 리액티브 바인딩용 이벤트 디스패치
    const injectSuccess = await page.evaluate((sel, html) => {
      const contentEl = document.querySelector(sel) as HTMLElement;
      if (!contentEl) return false;

      contentEl.innerHTML = html;

      ['input', 'change', 'keyup', 'keypress', 'keydown', 'blur'].forEach((evtType) => {
        contentEl.dispatchEvent(new Event(evtType, { bubbles: true, cancelable: true }));
      });

      return true;
    }, contentSelector, htmlContent);

    if (injectSuccess) {
      console.log('[Uploader] HTML 직접 주입 대기 중...');
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // 4) 에디터가 최종 변경 상태를 확실하게 저장하도록 포커스를 다시 잡고 백스페이스/스페이스 입력 시뮬레이션
      console.log('[Uploader] 에디터 최종 변경 확정을 위한 마이크로 인터랙션 시뮬레이션...');
      await page.evaluate((sel) => {
        const contentEl = document.querySelector(sel) as HTMLElement;
        if (contentEl) {
          contentEl.focus();
          
          // 캐럿을 에디터의 맨 끝으로 이동
          const selection = window.getSelection();
          if (selection) {
            const range = document.createRange();
            range.selectNodeContents(contentEl);
            range.collapse(false); // 끝으로 collapse
            selection.removeAllRanges();
            selection.addRange(range);
          }
        }
      }, contentSelector);
      
      // 포커스 상태에서 스페이스바 하나 입력 후 백스페이스를 눌러 돔 강제 갱신 트리거
      await page.keyboard.press('Space');
      await new Promise((resolve) => setTimeout(resolve, 200));
      await page.keyboard.press('Backspace');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      console.log('[Uploader] 하이브리드 본문 주입 및 에디터 락인 완료!');
    } else {
      console.warn('[Uploader] 본문 직접 주입 실패. 백업 page.type 실행.');
      await page.type(contentSelector, formattedContent, { delay: 10 });
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    // 5) 이미지 업로드 프로세스
    if (localImagePaths.length > 0) {
      setStage('IMAGE');
      console.log(`[Uploader] 총 ${localImagePaths.length}장의 실물 사진 업로드 중...`);
      try {
        // 툴바의 사진 업로드 버튼 (.se-image-toolbar-button) 대기 및 클릭
        const imageBtnSelector = '.se-image-toolbar-button';
        await page.waitForSelector(imageBtnSelector, { timeout: 10000 });
        console.log('[Uploader] 사진 툴바 버튼 클릭 시도...');
        await page.evaluate((sel) => {
          const el = document.querySelector(sel) as HTMLElement;
          if (el) {
            el.focus();
            const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
            el.dispatchEvent(clickEvent);
          }
        }, imageBtnSelector);

        // 동적으로 생성되는 파일 인풋 대기
        const fileInputSelector = 'input[type="file"], .input_file, #file_select';
        await page.waitForSelector(fileInputSelector, { timeout: 10000 });
        const fileInput = await page.$(fileInputSelector);
        if (fileInput) {
          await (fileInput as any).uploadFile(...localImagePaths);
          await new Promise((resolve) => setTimeout(resolve, 7000)); // 이미지 업로드 완료 및 본문 삽입 대기 시간 넉넉히 부여
          console.log('[Uploader] 이미지 업로드 완료!');
        } else {
          console.warn('[Uploader] 이미지 파일 업로드 인풋 요소를 찾지 못했습니다.');
        }
      } catch (imgErr) {
        console.error('[Uploader] 이미지 업로드 중 에러 발생:', imgErr);
      }
    }

    // 6) 최종 "등록" 버튼 클릭
    setStage('REGISTER');
    console.log('[Uploader] 글 등록 완료 중...');
    // GnbBntRight__green 클래스가 모바일 GNB 등록 버튼
    const registerBtnSelector = '.GnbBntRight__green, .btn_register, .btn_upload, button.submit, button[type="submit"]';
    await page.waitForSelector(registerBtnSelector, { timeout: 10000 });
    
    // 클릭 전 조금 더 넉넉하게 대기 (이미지 및 데이터 렌더링 동기화 완료 대기)
    await new Promise((resolve) => setTimeout(resolve, 3000));
    
    console.log('[Uploader] 등록 버튼 클릭 시도...');
    await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      if (el) {
        el.focus();
        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
        el.dispatchEvent(clickEvent);
      }
    }, registerBtnSelector);

    // 등록 버튼 누르고 5초 대기 (기존의 로컬 고정파일 스크린샷은 제거 — 실패 시에만 버킷에 올린다)
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // 완료 내비게이션 대기
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {
      console.log('[Uploader] 글 등록 후 내비게이션 타임아웃. 현재 URL 확인 중...');
    });

    // 7) 등록 완료된 글 URL 파싱 및 오류 검증
    setStage('VERIFY');
    const finalUrl = page.url();
    console.log(`[Uploader] 최종 리다이렉트 URL 확인: ${finalUrl}`);
    
    // 등록 실패 검증: 여전히 글쓰기(/articles/write) 페이지에 머무르고 있다면, 등록 경고 팝업 등의 영향으로 실제 글 등록 실패로 간주
    if (finalUrl.includes('/articles/write')) {
      throw new Error(`글 등록에 실패했습니다. 여전히 글쓰기 폼 페이지에 위치해 있습니다. (현재 URL: ${finalUrl}). 팝업 경고나 벨리데이션 차단 원인 파악 필요.`);
    }

    console.log(`[Uploader] 자동 포스팅이 성공적으로 완료되었습니다! 등록 URL: ${finalUrl}`);

    return finalUrl;
  } catch (err: any) {
    console.error('[Uploader] 자동 업로드 프로세스 도중 심각한 에러 발생:', err);

    // 예외 메시지를 삼키지 않고 단계·사유로 분류해 기록한다 (기존에는 전부 null로 소실)
    const msg = String(err?.message || err || '');
    const reason: UploadDiagnostics['reason'] =
      /가입 권한|멤버만|글쓰기 권한/.test(msg) ? 'MEMBERSHIP'
      : /여전히 글쓰기 폼/.test(msg) ? 'STILL_ON_WRITE_FORM'
      : /timeout|Waiting for selector|exceeded/i.test(msg) ? 'TIMEOUT'
      : 'EXCEPTION';
    await recordDiagnostics(page, reason, msg);

    return null;
  } finally {
    // 성공/실패/조기반환/catch 내부 예외까지 모든 경로에서 정리를 보장한다.
    // 브라우저를 정상 종료해야 크롬이 "비정상 종료" 플래그를 남기지 않고, 다음 실행에서
    // 세션 복원으로 탭이 되살아나는 누적을 막는다. (ensurePosterSession과 동일한 패턴)
    cleanLocalTempImages(localImagePaths);
    await browser.close().catch(() => {});
  }
}
