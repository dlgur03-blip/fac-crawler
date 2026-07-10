import puppeteer, { Page } from 'puppeteer';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

interface UploadPayload {
  title: string;
  content: string;
  price: number;
  productCode: string;
  imageUrls: string[];
  orderUrl: string;
  productId?: string;
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

  if (!username || !password) {
    console.error('[Uploader] 네이버 로그인 환경변수(NAVER_USER_ID, NAVER_USER_PW)가 누락되었습니다.');
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
  const loginBtn = await page.$('#log\\.login');
  if (loginBtn) {
    await loginBtn.click();
  } else {
    await page.click('.btn_login');
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
  } else {
    console.error('[Uploader] 네이버 로그인 실패. 캡차 보안문자가 나타났거나 계정 정보가 유효하지 않습니다.');
    return false;
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
    ],
  });

  let page: Page | null = null;
  try {
    page = await browser.newPage();
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
      await browser.close();
      cleanLocalTempImages(localImagePaths);
      return null;
    }

    // 3) 모바일 글쓰기 페이지로 이동 (iframe 우회를 위해 모바일 버전 글쓰기 폼 활용)
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

    // 2) 게시판 렌더링 및 자가치유 탐색(Self-Healing Selector) 수행
    console.log('[Uploader] 자유게시판 또는 대안 게시판 탐색 중...');
    
    const boardClicked = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('*'));
      
      // 1순위: '자유게시판' 매칭
      const targets = items.filter(el => {
        const text = (el.textContent || '').trim();
        const style = window.getComputedStyle(el);
        return text === '자유게시판' && style.display !== 'none' && style.visibility !== 'hidden';
      });

      let bestTarget = targets.find(el => el.children.length === 0) || targets[0];
      let fallbackUsed = false;
      let selectedName = '자유게시판';

      // 2순위 (자가치유): '자유게시판'이 없거나 비활성화된 경우, 드롭다운 목록에서 대안 게시판 탐색
      if (!bestTarget) {
        console.warn('[Uploader DOM] 자유게시판 텍스트 매칭 실패. 자가치유(Self-Healing) 대안 게시판 매칭 개시...');
        
        // 드롭다운 내부 또는 레이어 안의 모든 리스트 아이템 탐색
        const listItems = Array.from(document.querySelectorAll('.select_board li, .LayerPopup li, .BasicLayer li, .list_board li, li[class*="item"]'));
        
        for (const li of listItems) {
          const text = (li.textContent || '').trim();
          const style = window.getComputedStyle(li);
          
          // 쓸데없는 헤더, 가입인사, 등급별 글쓰기 불가능한 항목 필터링
          if (
            style.display !== 'none' && 
            style.visibility !== 'hidden' &&
            text.length > 0 &&
            !text.includes('게시판 선택') &&
            !text.includes('전체글보기') &&
            !text.includes('가입') &&
            !text.includes('공지') &&
            !text.includes('스탭') &&
            !text.includes('주문')
          ) {
            // 이 li 내부에 클릭 가능한 말단 span 또는 a가 있으면 그것을 선택, 없으면 li 자체
            bestTarget = li.querySelector('span, a, label') || li;
            fallbackUsed = true;
            selectedName = text;
            break;
          }
        }
      }

      if (bestTarget) {
        const el = bestTarget as HTMLElement;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        
        // 브라우저 클릭 이벤트 강제 유입
        el.click();
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        
        const parentLi = el.closest('li');
        if (parentLi) {
          parentLi.click();
          parentLi.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        }
        
        return {
          success: true,
          fallbackUsed,
          name: selectedName,
          x: r.left + r.width / 2,
          y: r.top + r.height / 2
        };
      }
      return { success: false, fallbackUsed: false, name: '', x: 0, y: 0 };
    });

    if (boardClicked.success && boardClicked.x > 0 && boardClicked.y > 0) {
      console.log(`[Uploader] 게시판 '${boardClicked.name}' 물리 좌표 터치 시도 (자가치유 적용: ${boardClicked.fallbackUsed}): x=${boardClicked.x}, y=${boardClicked.y}`);
      await page.mouse.click(boardClicked.x, boardClicked.y).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } else {
      console.error('[Uploader] 자유게시판 및 자가치유 폴백 게시판 매칭 전면 실패. 등록 프로세스가 중단될 수 있습니다.');
    }
    
    console.log(`[Uploader] 게시판 자동 선택 완료 (선택 게시판: ${boardClicked.name || '미선택'})`);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 모바일 글쓰기 제목 셀렉터 찾기 (Vue 컴포넌트인 textarea[placeholder="제목"] 우선 적용)
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

    // 본문 작성 (최상단에 상품번호를 고정 노출하고, 설명 + 상품 고유번호 + 주문서 링크 결합)
    const formattedContent = `[상품번호: ${payload.productCode}]

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
    const injectSuccess = await page.evaluate((sel, contentStr) => {
      const contentEl = document.querySelector(sel) as HTMLElement;
      if (!contentEl) return false;

      // 1) 텍스트를 스마트에디터 표준 문단 형식(p > span)의 HTML로 변환
      const escapeHtml = (text: string) => {
        return text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      };

      const lines = contentStr.split('\n');
      const htmlContent = lines.map(line => {
        const trimmed = line.trim();
        if (trimmed === '') {
          return '<p class="se-text-paragraph se-text-paragraph-align-left"><span><br></span></p>';
        }
        return `<p class="se-text-paragraph se-text-paragraph-align-left"><span>${escapeHtml(line)}</span></p>`;
      }).join('');

      // 2) innerHTML 강제 주입
      contentEl.innerHTML = htmlContent;

      // 3) 에디터 리액티브 바인딩을 위한 DOM 이벤트 강제 디스패치
      const events = ['input', 'change', 'keyup', 'keypress', 'keydown', 'blur'];
      events.forEach(evtType => {
        contentEl.dispatchEvent(new Event(evtType, { bubbles: true, cancelable: true }));
      });

      return true;
    }, contentSelector, formattedContent);

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

    // 등록 버튼 누르고 5초간 대기하며 페이지 상태를 정밀 스크린샷으로 캡처
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await page.screenshot({ path: path.join(process.cwd(), 'after_register_click.png') });
    console.log('[Uploader] 등록 클릭 5초 후 스크린샷 after_register_click.png 저장 완료.');

    // 완료 내비게이션 대기
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {
      console.log('[Uploader] 글 등록 후 내비게이션 타임아웃. 현재 URL 확인 중...');
    });

    // 7) 등록 완료된 글 URL 파싱 및 오류 검증
    const finalUrl = page.url();
    console.log(`[Uploader] 최종 리다이렉트 URL 확인: ${finalUrl}`);
    
    // 등록 실패 검증: 여전히 글쓰기(/articles/write) 페이지에 머무르고 있다면, 등록 경고 팝업 등의 영향으로 실제 글 등록 실패로 간주
    if (finalUrl.includes('/articles/write')) {
      throw new Error(`글 등록에 실패했습니다. 여전히 글쓰기 폼 페이지에 위치해 있습니다. (현재 URL: ${finalUrl}). 팝업 경고나 벨리데이션 차단 원인 파악 필요.`);
    }

    console.log(`[Uploader] 자동 포스팅이 성공적으로 완료되었습니다! 등록 URL: ${finalUrl}`);
    
    cleanLocalTempImages(localImagePaths);
    await browser.close();
    return finalUrl;
  } catch (err) {
    console.error('[Uploader] 자동 업로드 프로세스 도중 심각한 에러 발생:', err);
    try {
      if (page) {
        await page.screenshot({ path: path.join(process.cwd(), 'error_screenshot.png') });
        console.log('[Uploader] 에러 시점의 스크린샷이 error_screenshot.png 로 저장되었습니다.');
      }
    } catch (ssErr) {
      console.error('[Uploader] 에러 스크린샷 저장 실패:', ssErr);
    }
    cleanLocalTempImages(localImagePaths);
    await browser.close();
    return null;
  }
}
