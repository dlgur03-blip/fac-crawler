import puppeteer, { Page } from 'puppeteer';
import { supabase } from '../supabase/client';

export interface ScrapedProduct {
  naverArticleId: string;
  title: string;
  content: string;
  price: number;
  imageUrls: string[];
  naverArticleUrl: string;
}

/**
 * 1. 네이버 카페 목록 수집 (핫딜매니저 작성글 필터링)
 */
export async function scrapeArticleList(
  clubId: string,
  menuId: string
): Promise<string[]> {
  const url = `https://cafe.naver.com/f-e/cafes/${clubId}/menus/${menuId}?viewType=L`;
  console.log(`[Crawler] 목록 수집을 위해 Puppeteer 실행 중... URL: ${url}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1280,1024',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1024 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // 게시글 ID 목록 파싱
    const articleIds = await page.evaluate(() => {
      const ids: string[] = [];
      const links = document.querySelectorAll('a');
      links.forEach((a) => {
        const href = a.getAttribute('href') || '';
        // /ArticleRead.nhn?clubid=...&articleid=XXXX 형태의 링크에서 ID 추출
        if (href.includes('ArticleRead.nhn')) {
          const match = href.match(/articleid=(\d+)/);
          if (match && match[1]) {
            ids.push(match[1]);
          }
        } else if (href.includes('/articles/')) {
          // /articles/XXXX 형태의 링크 대응
          const match = href.match(/\/articles\/(\d+)/);
          if (match && match[1]) {
            ids.push(match[1]);
          }
        }
      });
      // 중복 제거
      return Array.from(new Set(ids));
    });

    console.log(`[Crawler] 총 ${articleIds.length}개의 잠재적 게시글 ID를 수집했습니다.`);
    return articleIds;
  } catch (error) {
    console.error('[Crawler] 목록 수집 중 오류 발생:', error);
    return [];
  } finally {
    await browser.close();
  }
}

/**
 * 2. 네이버 카페 모바일 상세 페이지 우회 크롤링
 */
export async function scrapeArticleDetail(
  clubId: string,
  articleId: string
): Promise<ScrapedProduct | null> {
  const mobileUrl = `https://m.cafe.naver.com/ca-fe/web/cafes/${clubId}/articles/${articleId}`;
  console.log(`[Crawler] 상세 수집 중... Article ID: ${articleId}, URL: ${mobileUrl}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=375,812',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({
      width: 375,
      height: 812,
      isMobile: true,
      hasTouch: true,
    });
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1'
    );

    await page.goto(mobileUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const data = await page.evaluate(() => {
      // 1) 제목 파싱 (출처 등 숨김 텍스트 .blind 제거 가드 장착)
      // 1) 제목 파싱 (출처 등 숨김 텍스트 .blind 제거 가드 장착)
      const titleEl = document.querySelector(
        '.ArticleTitle .title, .title_area .title, h2.title, h2.tit'
      );
      let title = '';
      if (titleEl) {
        const clone = titleEl.cloneNode(true) as HTMLElement;
        const blinds = clone.querySelectorAll('.blind, [class*="blind"], span.board_name, span.ellip, a.go_app, .tag');
        blinds.forEach((b) => b.remove());
        
        let parsedTitle = clone.innerText.trim() || clone.textContent?.trim() || '';
        
        // 🚨 정밀 제목 정제 알고리즘 (공지, 출처, 임의 수식어 완벽 제거)
        if (parsedTitle) {
          parsedTitle = parsedTitle.replace(/^(공지|\[공지\])\s*/i, '');
          parsedTitle = parsedTitle.replace(/^\[실시간\s*핫딜\]\s*/i, '');
          parsedTitle = parsedTitle.replace(/^\[핫딜\]\s*/i, '');
          parsedTitle = parsedTitle.replace(/\s*[\(\[]?출처\s*:\s*[^\]\)]+[\)\]]?/g, '');
          parsedTitle = parsedTitle.replace(/\s*출처\s*:\s*\S+/g, '');
          parsedTitle = parsedTitle.replace(/\s*[\(\[]?재고\s*소량[\)\]]?/i, '');
          parsedTitle = parsedTitle.replace(/\s+/g, ' ').trim();
        }
        title = parsedTitle;
      }

      // 2) 본문 텍스트 및 이미지 추출
      const contentEl = document.querySelector(
        '.se-viewer, .se-main-container, .ArticleContentBox, .article_viewer, #postContent'
      );
      let content = '';
      const imageUrls: string[] = [];

      if (contentEl) {
        const clone = contentEl.cloneNode(true) as HTMLElement;
        const blinds = clone.querySelectorAll('.blind, [class*="blind"]');
        blinds.forEach((b) => b.remove());
        
        let parsedContent = clone.innerText.trim() || clone.textContent?.trim() || '';
        
        // 🚨 정밀 본문 정제 알고리즘 (끝단 메타 찌꺼기 제거 & 3회 이상 무의미한 연속 개행 압축)
        if (parsedContent) {
          parsedContent = parsedContent.replace(/투표는\s*표시되지\s*않습니다\.?/gi, '');
          parsedContent = parsedContent.replace(/첨부파일\s*\d+\s*개/gi, '');
          parsedContent = parsedContent.split('\n').map(line => line.trim()).join('\n');
          parsedContent = parsedContent.replace(/\n{3,}/g, '\n\n').trim();
        }
        content = parsedContent;
        
        const imgs = contentEl.querySelectorAll('img');
        imgs.forEach((img) => {
          const src =
            img.getAttribute('data-lazy-src') ||
            img.getAttribute('src') ||
            '';
          // 네이버 기본 스태틱 리소스 및 블랭크 이미지 필터링
          if (
            src &&
            !src.includes('static.naver') &&
            !src.includes('blank.gif') &&
            src.startsWith('http')
          ) {
            imageUrls.push(src);
          }
        });
      } else {
        content = document.body.innerText;
      }

      return { title, content, imageUrls };
    });

    if (!data.title) {
      console.warn(`[Crawler] Article ${articleId}의 제목을 파싱할 수 없어 스킵합니다.`);
      return null;
    }

    // 3) 가격 파싱 알고리즘 (본문 텍스트에서 4~6자리 연속된 숫자를 찾거나 "원" 앞의 숫자 추출)
    let price = 30000; // 기본값
    // 본문의 첫 3줄 내에서 가격을 유추
    const lines = data.content.split('\n').slice(0, 5);
    for (const line of lines) {
      // 10,000 혹은 10000 형태 매칭
      const match = line.replace(/,/g, '').match(/\b\d{4,6}\b/);
      if (match) {
        const val = parseInt(match[0], 10);
        // 현실적인 가격 범위 (5,000원 ~ 1,000,000원) 내인 경우 추출 성공으로 간주
        if (val >= 5000 && val <= 1000000) {
          price = val;
          break;
        }
      }
    }

    return {
      naverArticleId: articleId,
      title: data.title,
      content: data.content,
      price,
      imageUrls: data.imageUrls,
      naverArticleUrl: `https://cafe.naver.com/f-e/${articleId}`,
    };
  } catch (error) {
    console.error(`[Crawler] Article ${articleId} 상세 정보 수집 실패:`, error);
    return null;
  } finally {
    await browser.close();
  }
}

/**
 * 3. 초기 마이그레이션 실행기 (Scrape ➡️ Supabase DB 연동)
 */
export async function runInitialMigration(
  clubId: string,
  menuId: string,
  limit: number = 5
) {
  console.log(`[Migration] 초기 마이그레이션을 시작합니다. (최대 ${limit}개 대상)`);

  const articleIds = await scrapeArticleList(clubId, menuId);
  const targetIds = articleIds.slice(0, limit);

  let successCount = 0;

  for (const articleId of targetIds) {
    const productData = await scrapeArticleDetail(clubId, articleId);
    if (!productData) continue;

    console.log(`[Migration] DB에 상품 적재 중: ${productData.title}`);

    try {
      // 1) PRODUCTS 테이블에 상품 정보 업서트
      const { data: insertedProduct, error: productError } = await supabase
        .from('products')
        .upsert(
          {
            title: productData.title,
            content: productData.content,
            price: productData.price,
            stock_quantity: 5, // 기본 재고 설정
            naver_article_url: productData.naverArticleUrl,
            is_active: true,
          },
          { onConflict: 'naver_article_url' } // 카페 원본 링크 기준 중복 포스팅 방지
        )
        .select()
        .single();

      if (productError || !insertedProduct) {
        console.error(`[Migration] Product DB 적재 오류:`, productError);
        continue;
      }

      // 2) PRODUCT_IMAGES 테이블에 기존 이미지 초기화 후 신규 적재
      // 기존 이미지 제거
      await supabase
        .from('product_images')
        .delete()
        .eq('product_id', insertedProduct.id);

      // 새 이미지 일괄 삽입
      if (productData.imageUrls.length > 0) {
        const imagePayload = productData.imageUrls.map((url, index) => ({
          product_id: insertedProduct.id,
          image_url: url,
          display_order: index,
        }));

        const { error: imageError } = await supabase
          .from('product_images')
          .insert(imagePayload);

        if (imageError) {
          console.error(`[Migration] Product Images 적재 오류:`, imageError);
        }
      }

      successCount++;
      console.log(`[Migration] 상품 마이그레이션 성공: ${productData.title}`);
    } catch (dbError) {
      console.error(`[Migration] DB 트랜잭션 오류:`, dbError);
    }
  }

  console.log(
    `[Migration] 마이그레이션이 완료되었습니다. 성공 건수: ${successCount}/${targetIds.length}`
  );
}

/* ============================================================================
 * 4. 영속 세션(로그인된 Page) 주입형 크롤러 — 크롤러 데몬 전용
 * ========================================================================== */

export interface CafeListItem {
  articleId: number;
  title: string;
  author: string;
  isNotice: boolean;
}

export interface CafeArticleDetail {
  articleId: number;
  title: string;
  content: string;
  imageUrls: string[];
  authorNickname: string;
  postedAt: string | null;
  sourcePrice: number | null;
  fee: number;
  sizes: string;
  colors: string;
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 공지 제목 휴리스틱: 📢 / [필독...] / [공지...] / 후기 이벤트 / 셀러 모집 */
const NOTICE_TITLE_RE = /^(📢|\[?필독|\[?공지)|후기\s*이벤트|셀러\s*모집/;

/**
 * 게시시각 텍스트 → ISO 문자열 파싱
 * 지원 포맷: "2026.06.12. 14:03", "2026.6.12.", "14:03"(당일 글)
 */
function parsePostedAtText(raw: string): string | null {
  if (!raw) return null;
  const text = raw.trim();

  // "2026.06.12. 14:03" 또는 "2026.06.12."
  const full = text.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*(?:(\d{1,2}):(\d{2}))?/);
  if (full) {
    const d = new Date(
      parseInt(full[1], 10),
      parseInt(full[2], 10) - 1,
      parseInt(full[3], 10),
      full[4] ? parseInt(full[4], 10) : 0,
      full[5] ? parseInt(full[5], 10) : 0
    );
    if (!isNaN(d.getTime())) return d.toISOString();
    return null;
  }

  // 당일 글은 "14:03" 형식으로 노출되는 경우 대응
  const timeOnly = text.match(/^(\d{1,2}):(\d{2})$/);
  if (timeOnly) {
    const now = new Date();
    const d = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      parseInt(timeOnly[1], 10),
      parseInt(timeOnly[2], 10)
    );
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  return null;
}

/**
 * 제목에서 사이즈 옵션 추출
 * - "110.120.130" 식 점 구분 숫자 → "110,120,130"
 * - "S,M,L" 식 알파 사이즈 콤마 패턴 → "S,M,L"
 */
function parseSizesFromTitle(title: string): string {
  const dotted = title.match(/(\d{2,3})((?:\.\d{2,3})+)/);
  if (dotted) {
    return (dotted[1] + dotted[2]).split('.').join(',');
  }
  const alpha = title.match(/\b(?:XS|S|M|L|XL|XXL|2XL|3XL)(?:\s*,\s*(?:XS|S|M|L|XL|XXL|2XL|3XL))+\b/i);
  if (alpha) {
    return alpha[0].replace(/\s+/g, '').toUpperCase();
  }
  return '';
}

/* ----------------------------------------------------------------------------
 * 옵션(사이즈/컬러) 파싱 — 2026-07-10
 * 원칙: 미추출 > 과추출 (틀린 옵션이 노출되느니 빈 값으로 두고 어드민 수동 보정)
 * -------------------------------------------------------------------------- */

const ALPHA_SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', '4XL'];

// 실측 카페 상품글에서 쓰이는 컬러 표기 사전 (라벨 없는 열거 라인 판정용)
const COLOR_DICT = new Set([
  '블랙', '화이트', '아이보리', '베이지', '크림', '그레이', '차콜', '네이비', '곤색',
  '카키', '브라운', '와인', '버건디', '핑크', '소라', '연청', '중청', '진청', '흑청',
  '오트밀', '머스타드', '민트', '라벤더', '레드', '블루', '그린', '옐로우', '퍼플',
  '오렌지', '스카이', '모카', '카멜', '캐멀', '먹색', '백색', '흑색', '회색', '검정',
  '흰색', '노랑', '파랑', '빨강', '초록', '보라',
]);

/** "S~XL" 알파 범위를 고정 순서표로 전개. 순서표 밖이거나 역순이면 null */
function expandAlphaSizeRange(a: string, b: string): string[] | null {
  const i = ALPHA_SIZE_ORDER.indexOf(a.toUpperCase());
  const j = ALPHA_SIZE_ORDER.indexOf(b.toUpperCase());
  if (i === -1 || j === -1 || i >= j) return null;
  return ALPHA_SIZE_ORDER.slice(i, j + 1);
}

/** 옵션 토큰 공통 필터: 1~10자, 숫자 시작 아님(사이즈 제외), 잡단어 배제 */
function cleanOptionTokens(raw: string, allowNumeric: boolean): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw.split(/[,/·|]+|\s{2,}|\s(?=\S)/).map((s) => s.trim()).filter(Boolean)) {
    if (t.length < 1 || t.length > 10) continue;
    if (!allowNumeric && /\d/.test(t)) continue;
    if (/원|사이즈|컬러|색상|옵션|배송|주문|가격/.test(t)) continue;
    const key = t.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 15) break; // 잡텍스트 폭주 가드
  }
  return out;
}

/**
 * 제목+본문에서 사이즈/컬러 옵션 추출.
 * 사이즈 우선순위: 라벨 라인 → 제목 점구분 숫자 → 본문 점구분 숫자(3개 이상, 가격 라인 제외)
 *                → 알파 콤마 패턴(제목→본문) → 프리사이즈
 * 컬러: 라벨 라인 → 라벨 없는 열거 라인(사전 70% 히트)
 */
export function parseOptions(title: string, content: string): { sizes: string; colors: string } {
  const lines = (content || '').split('\n').map((l) => l.trim()).filter(Boolean);
  let sizes = '';
  let colors = '';

  for (const line of lines) {
    // 사이즈 라벨 라인: "사이즈 : S,M,L" / "size: 90~110"
    if (!sizes) {
      const m = line.match(/^(?:사이즈|size)\s*[:：]\s*(.+)$/i);
      if (m) {
        const range = m[1].match(/^([A-Za-z0-9]{1,3})\s*[~-]\s*([A-Za-z0-9]{1,3})$/);
        if (range && /[A-Za-z]/.test(range[1])) {
          const expanded = expandAlphaSizeRange(range[1], range[2]);
          if (expanded) sizes = expanded.join(',');
        }
        if (!sizes) {
          const tokens = cleanOptionTokens(m[1], true);
          if (tokens.length) sizes = tokens.map((t) => t.toUpperCase()).join(',');
        }
      }
    }
    // 컬러 라벨 라인: "컬러 : 블랙/아이보리" / "색상: 크림, 소라"
    if (!colors) {
      const m = line.match(/^(?:컬러|칼라|색상|color)\s*[:：]\s*(.+)$/i);
      if (m) {
        const tokens = cleanOptionTokens(m[1], false);
        if (tokens.length) colors = tokens.join(',');
      }
    }
    if (sizes && colors) break;
  }

  // 제목 점구분 숫자 "110.120.130" (기존 로직)
  if (!sizes) sizes = parseSizesFromTitle(title);

  // 본문 점구분 숫자 라인 — 숫자 3개 이상 요구("14.700" 천단위 가격 오인 차단) + 가격 라인 제외
  if (!sizes) {
    for (const line of lines) {
      const norm = line.replace(/원/g, ' ').trim();
      if (norm.match(PRICE_PAIR_RE) || norm.match(PRICE_PAIR_END_RE)) continue;
      const m = line.match(/^(\d{2,3})((?:\.\d{2,3}){2,})$/);
      if (m) {
        sizes = (m[1] + m[2]).split('.').join(',');
        break;
      }
    }
  }

  // 알파 콤마 패턴 (본문)
  if (!sizes) {
    for (const line of lines) {
      const m = line.match(/\b(?:XS|S|M|L|XL|XXL|2XL|3XL)(?:\s*,\s*(?:XS|S|M|L|XL|XXL|2XL|3XL))+\b/i);
      if (m) {
        sizes = m[0].replace(/\s+/g, '').toUpperCase();
        break;
      }
    }
  }

  // 프리사이즈: "프리사이즈"/"FREE size" 명시 또는 단독 "FREE" 라인만 인정
  if (!sizes && (/(?:프리|free)\s*(?:사이즈|size)/i.test(content) || lines.some((l) => /^free$/i.test(l)))) {
    sizes = 'FREE';
  }

  // 라벨 없는 컬러 열거 라인: 토큰 2개 이상 + 사전 히트율 70% 이상
  if (!colors) {
    for (const line of lines) {
      if (/\d/.test(line) || line.length > 60) continue;
      const tokens = cleanOptionTokens(line, false);
      if (tokens.length < 2) continue;
      const hits = tokens.filter((t) => COLOR_DICT.has(t)).length;
      if (hits / tokens.length >= 0.7) {
        colors = tokens.join(',');
        break;
      }
    }
  }

  return { sizes, colors };
}

/**
 * 본문에서 상품금액/수수료 추출
 * - 라인별로 천단위 구분자(콤마·마침표)와 '원' 제거 후 "80000 4000" 식 (금액 수수료) 패턴 첫 매칭
 *   (실측: 본문이 "14.700 5.000" 처럼 마침표 천단위 표기를 씀 — 2026-06-12 라이브 확인)
 * - 쌍이 없으면 단일 숫자 라인을 sourcePrice로, fee=0
 * - 전무하면 sourcePrice=null
 */
// 금액 토큰: 천단위 구분(7.900 / 4,000) 또는 구분자 없는 4~7자리(80000)
// 실측(2026-06-12): "7.900 4.00080×100" 처럼 가격 뒤에 사이즈가 개행 없이 붙는 경우가 있어
// 끝 앵커($) 대신 토큰 경계까지만 매칭하고 잔여 텍스트는 무시한다.
const PRICE_PAIR_RE = /^(\d{1,3}(?:[.,]\d{3})+|\d{4,7})\s+(\d{1,3}(?:[.,]\d{3})+|\d{3,6})/;
// 실측(2026-06-12): 가입 배너와 본문이 한 줄로 붙어 가격이 줄 끝에 옴 — "...가입하기6000 3000", "...가입하기9000   0"
// 줄 끝 앵커 + 앞 경계(비숫자) + 수수료 0 명시 허용
const PRICE_PAIR_END_RE = /(?:^|\D)(\d{1,3}(?:[.,]\d{3})+|\d{4,7})\s+(\d{1,3}(?:[.,]\d{3})+|\d{1,6})\s*$/;
const PRICE_SINGLE_RE = /^(\d{1,3}(?:[.,]\d{3})+|\d{4,7})(?!\d)/;

function parseAmountToken(token: string): number {
  return parseInt(token.replace(/[.,]/g, ''), 10);
}

// 제목 가격 폴백 (실측 2026-07-24: 본문에 가격 없이 제목에만 "15000원!!", "20000>>10000원", ">> 만원" 표기하는
// 셀러 패턴으로 사이클당 45건 파싱 실패 → 누락). '원'이 붙은 금액만 인정 — 맨숫자는 사이즈 나열(110 120 130) 오인 위험.
const TITLE_AMT = '(\\d{1,3}(?:[.,]\\d{3})+|\\d{4,7})';
const TITLE_PAIR_RE = new RegExp(`${TITLE_AMT}\\s*(?:>{1,3}|→|⇒)\\s*${TITLE_AMT}\\s*원`);
const TITLE_WON_RE = new RegExp(`${TITLE_AMT}\\s*원`, 'g');
const TITLE_MANWON_RE = /(?:^|[^\d.])(\d{1,3}(?:\.\d)?)?\s*만\s*원/;

export function parsePriceFromTitle(title: string): number | null {
  if (!title) return null;
  const t = title.replace(/\s+/g, ' ');
  const inRange = (v: number) => (v >= 1000 && v <= 2000000 ? v : null);

  // 1) "20000>>10000원" 류 할인 표기 — 뒤쪽(최종가) 채택
  const pair = t.match(TITLE_PAIR_RE);
  if (pair) {
    const v = inRange(parseAmountToken(pair[2]));
    if (v !== null) return v;
  }

  // 2) "N원" — 여러 개면 마지막(정상가→최종가 순 표기 관행)
  const wonMatches = [...t.matchAll(TITLE_WON_RE)];
  for (let i = wonMatches.length - 1; i >= 0; i--) {
    const v = inRange(parseAmountToken(wonMatches[i][1]));
    if (v !== null) return v;
  }

  // 3) "1.5만원" / "만원"(숫자 생략 = 1만)
  const man = t.match(TITLE_MANWON_RE);
  if (man) {
    const n = man[1] ? parseFloat(man[1]) : 1;
    const v = inRange(Math.round(n * 10000));
    if (v !== null) return v;
  }

  return null;
}

function parsePriceAndFee(content: string): { sourcePrice: number | null; fee: number } {
  const lines = content.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.replace(/원/g, ' ').replace(/ /g, ' ').trim();
    const m = line.match(PRICE_PAIR_RE);
    if (m) {
      const a = parseAmountToken(m[1]);
      const b = parseAmountToken(m[2]);
      if (a >= b && a >= 1000 && a <= 2000000 && b >= 100 && b <= 100000) {
        return { sourcePrice: a, fee: b };
      }
    }
  }

  // 줄 끝 쌍 매칭 (배너 등 잡텍스트 뒤에 가격이 붙는 경우). 수수료는 0(명시) 또는 100~10만만 인정 — 1~99는 수량 오인 가능성
  for (const rawLine of lines) {
    const line = rawLine.replace(/원/g, ' ').replace(/ /g, ' ').trim();
    const m = line.match(PRICE_PAIR_END_RE);
    if (m) {
      const a = parseAmountToken(m[1]);
      const b = parseAmountToken(m[2]);
      if (a >= b && a >= 1000 && a <= 2000000 && (b === 0 || (b >= 100 && b <= 100000))) {
        return { sourcePrice: a, fee: b };
      }
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/원/g, ' ').replace(/ /g, ' ').trim();
    const m = line.match(PRICE_SINGLE_RE);
    if (m) {
      const a = parseAmountToken(m[1]);
      if (a >= 1000 && a <= 2000000) {
        return { sourcePrice: a, fee: 0 };
      }
    }
  }

  return { sourcePrice: null, fee: 0 };
}

/**
 * 제목에서 품절 표기 감지 — 셀러가 "(품절)"/"완판" 등을 제목에 박는 패턴 (실측 2026-06-12, #418937)
 * 감지 시 is_soldout 자동 세팅으로 oversell 차단. 재게시에서 표기가 빠지면 자동 해제(카페가 소스).
 */
export function detectSoldoutFromTitle(title: string): boolean {
  return /품절|완판|솔드\s*아웃|sold\s*out/i.test(title || '');
}

/**
 * 본문에서 카페 글 링크(naver.me 단축링크 또는 카페 글 URL) 추출.
 * 실측(2026-06-12): 이 카페 셀러들은 원본 상품글(가격·사진 포함)을 naver.me 링크 한 줄로
 * 끌어올리는 패턴이 지배적 — 링크 글 자체엔 가격이 없으므로 원본을 따라가야 한다.
 */
export function extractLinkedCafeUrl(content: string): string | null {
  const urls = extractLinkedCafeUrls(content);
  return urls.length ? urls[0] : null;
}

/**
 * 본문 내 카페 글 링크 전부 추출(최대 2개) — 꼬리 잡음(닫는 괄호·마침표·한글 붙음) 제거.
 * 실측: 본문에 링크가 여러 개거나 링크 뒤에 텍스트가 붙는 글이 있어 첫 링크 하나만으론 원본 회수 실패.
 */
export function extractLinkedCafeUrls(content: string): string[] {
  const matches = content.match(/https?:\/\/naver\.me\/[A-Za-z0-9]+|https?:\/\/(?:m\.)?cafe\.naver\.com\/\S+/g) || [];
  const out: string[] = [];
  for (const raw of matches) {
    const url = raw.replace(/[)\]>,."'”’]+$/g, '').replace(/[가-힣ㄱ-ㅎㅏ-ㅣ].*$/, '');
    if (url.startsWith('http') && !out.includes(url)) out.push(url);
    if (out.length >= 2) break;
  }
  return out;
}

/**
 * 링크를 따라가(리다이렉트 추적) 최종 카페 글의 clubId/articleId를 해석한다.
 */
export async function resolveCafeArticleIdFromUrl(
  page: Page,
  url: string
): Promise<{ clubId: string | null; articleId: number } | null> {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  } catch {
    /* 타임아웃이어도 현재 URL로 판정 */
  }
  await sleepMs(1500);
  const finalUrl = page.url();

  // 실측(2026-06-12): 공유 링크는 "ca-fe/web/cafes/{카페별칭}/articles/{글번호}" 로 풀림 — 별칭/숫자 모두 허용
  const m1 = finalUrl.match(/cafes\/([\w.-]+)\/articles\/(\d+)/);
  if (m1) return { clubId: /^\d+$/.test(m1[1]) ? m1[1] : null, articleId: parseInt(m1[2], 10) };
  const m2 = finalUrl.match(/articleid=(\d+)/i);
  if (m2) return { clubId: null, articleId: parseInt(m2[1], 10) };
  // 실측(2026-06-12): naver.me 공유 링크는 "m.cafe.naver.com/{카페별칭}/{글번호}" 형식으로 풀림
  // (별칭으론 clubId를 알 수 없음 — 호출부가 자기 clubId로 본문을 가져오므로 타 카페 글이면 자연 실패)
  const m3 = finalUrl.match(/m\.cafe\.naver\.com\/([\w.-]+)\/(\d+)(?:[/?#]|$)/);
  if (m3 && m3[1] !== 'ca-fe') return { clubId: null, articleId: parseInt(m3[2], 10) };
  return null;
}

/**
 * tsx(esbuild) keepNames가 함수에 주입하는 `__name` 헬퍼는 브라우저 컨텍스트에 존재하지 않아
 * page.evaluate로 직렬화된 함수가 ReferenceError(__name is not defined)를 던진다.
 * 문자열 evaluate는 esbuild 변환을 타지 않으므로 이 경로로 심(shim)을 주입한다.
 */
const NAME_SHIM = 'window.__name = window.__name || ((target, value) => target);';
const nameShimRegistered = new WeakSet<Page>();
async function injectEsbuildNameShim(page: Page): Promise<void> {
  if (!nameShimRegistered.has(page)) {
    nameShimRegistered.add(page);
    try {
      await page.evaluateOnNewDocument(NAME_SHIM); // 이후 모든 내비게이션에 선주입
    } catch { /* 등록 실패 시 아래 직접 주입으로 커버 */ }
  }
  try {
    await page.evaluate(NAME_SHIM); // 현재 문서에 즉시 주입
  } catch { /* 문서 전환 중이면 다음 evaluate 전 재시도됨 */ }
}

/**
 * 4-a. 카페 전체글 목록 수집 (로그인된 영속 Page 주입형)
 * - 페이지 순회: limit 도달 또는 빈 페이지까지 (페이지 간 2~3초 랜덤 지연)
 * - 공지 3중 가드: 공지영역/뱃지 구조 감지 + 제목 휴리스틱 + 페이지 간 재등장(고정공지) 감지
 */
export async function scrapeCafeList(
  page: Page,
  clubId: string,
  limit = 200
): Promise<CafeListItem[]> {
  const MAX_PAGES = 30; // 무한 루프 안전 가드
  const collected = new Map<
    number,
    { articleId: number; title: string; author: string; isNotice: boolean; firstPage: number }
  >();
  const pinnedIds = new Set<number>(); // 여러 페이지에 반복 노출되는 고정 공지

  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
    const url = `https://cafe.naver.com/f-e/cafes/${clubId}/menus/0?viewType=L&page=${pageNo}`;
    console.log(`[Crawler] 카페 목록 ${pageNo}페이지 수집 중: ${url}`);

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    } catch (navErr: any) {
      console.warn(`[Crawler] ${pageNo}페이지 networkidle2 대기 타임아웃 — 현재 DOM으로 파싱 진행:`, navErr?.message);
    }
    await sleepMs(2500);
    await injectEsbuildNameShim(page);

    const items: Array<{ articleId: number; title: string; author: string; isNotice: boolean }> =
      await page.evaluate(() => {
        const out: Array<{ articleId: number; title: string; author: string; isNotice: boolean }> = [];
        const seen = new Set<number>();

        // ── 1) 행 후보 셀렉터 폴백 체인 (구조 변경 대비 자가치유) ──
        const rowSelectorChains = [
          '.article-board tbody tr',
          'table.board-box tbody tr',
          '[class*="ArticleBoard"] tbody tr',
          '[class*="article-board"] tr',
          'ul[class*="article-list"] > li',
          '[class*="ArticleList"] [class*="item"]',
        ];
        let rows: Element[] = [];
        for (const sel of rowSelectorChains) {
          try {
            rows = Array.from(document.querySelectorAll(sel));
          } catch {
            rows = [];
          }
          if (rows.length > 0) break;
        }

        const extractFromAnchor = (a: Element, row: Element | null) => {
          const href = a.getAttribute('href') || '';
          if (href.includes('/articles/write')) return;
          const m = href.match(/\/articles\/(\d+)/) || href.match(/articleid=(\d+)/i);
          if (!m || !m[1]) return;
          const articleId = parseInt(m[1], 10);
          if (!articleId || seen.has(articleId)) return;

          // 제목 — 앵커 내부의 제목 전용 노드 우선, 폴백으로 앵커 전체 텍스트
          const titleEl =
            a.querySelector('.article, .inner_list .article, [class*="title"], [class*="tit"]') || a;
          let title = (titleEl.textContent || '').replace(/\s+/g, ' ').trim();
          // 댓글 수 카운트 앵커("[3]")는 제목으로 부적합 → 스킵하고 동일 ID의 다음 앵커에 기대지 않고 row 재탐색
          if (!title || /^\[?\d+\]?$/.test(title)) {
            if (row) {
              const altTitleEl = row.querySelector('a.article, [class*="title"] a, a[class*="tit"]');
              title = altTitleEl ? (altTitleEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
            }
            if (!title || /^\[?\d+\]?$/.test(title)) return;
          }

          // 작성자 — 폴백 체인
          let author = '';
          if (row) {
            const authorEl = row.querySelector(
              '.td_name .p-nick a, .td_name a, .p-nick, [class*="nickname"], [class*="nick"], [class*="writer"], [class*="author"]'
            );
            if (authorEl) author = (authorEl.textContent || '').replace(/\s+/g, ' ').trim();
          }

          // 공지 구조 감지 (i): 공지 영역/뱃지/클래스
          let isNotice = false;
          if (row) {
            const ownClasses = `${row.className || ''} ${(row.parentElement && row.parentElement.className) || ''}`;
            if (/notice/i.test(String(ownClasses))) isNotice = true;
            if (!isNotice && row.querySelector('[class*="notice"], [class*="Notice"], em.ico-list-notice')) {
              isNotice = true;
            }
            if (!isNotice && row.closest('[class*="notice"], [class*="Notice"]')) {
              isNotice = true;
            }
            // "공지" 라벨 셀 텍스트 감지
            if (!isNotice) {
              const badge = row.querySelector('td:first-child, [class*="badge"], [class*="label"]');
              if (badge && (badge.textContent || '').trim() === '공지') isNotice = true;
            }
          }

          seen.add(articleId);
          out.push({ articleId, title, author, isNotice });
        };

        if (rows.length > 0) {
          // 행 단위 추출 (견고)
          for (const row of rows) {
            const anchors = Array.from(row.querySelectorAll('a[href*="/articles/"], a[href*="articleid="]'));
            for (const a of anchors) {
              extractFromAnchor(a, row);
            }
          }
        } else {
          // 최후 폴백: 문서 전체 앵커 스캔 후 가장 가까운 행 컨테이너로 승격
          const anchors = Array.from(
            document.querySelectorAll('a[href*="/articles/"], a[href*="articleid="]')
          );
          for (const a of anchors) {
            const row = a.closest('tr, li, [class*="item"], [class*="Article"]');
            extractFromAnchor(a, row);
          }
        }

        return out;
      });

    let newCount = 0;
    for (const it of items) {
      const prev = collected.get(it.articleId);
      if (prev) {
        // 공지 가드 (iii): 2페이지 이상에서 재등장하는 동일 ID = 고정 공지
        if (prev.firstPage !== pageNo) {
          pinnedIds.add(it.articleId);
        }
        continue;
      }
      collected.set(it.articleId, { ...it, firstPage: pageNo });
      newCount++;
    }

    console.log(`[Crawler] ${pageNo}페이지에서 신규 ${newCount}건 수집 (누적 ${collected.size}건)`);

    if (newCount === 0) break; // 빈 페이지(또는 전부 중복) 도달

    const usableCount = Array.from(collected.values()).filter(
      (v) => !v.isNotice && !pinnedIds.has(v.articleId) && !NOTICE_TITLE_RE.test(v.title)
    ).length;
    if (usableCount >= limit) break;

    await sleepMs(2000 + Math.floor(Math.random() * 1000)); // 페이지 간 2~3초 랜덤 지연
  }

  // 공지 3중 가드 최종 적용: (i) 구조 감지 || (ii) 제목 휴리스틱 || (iii) 페이지 간 재등장
  const result: CafeListItem[] = Array.from(collected.values())
    .map((v) => ({
      articleId: v.articleId,
      title: v.title,
      author: v.author,
      isNotice: v.isNotice || pinnedIds.has(v.articleId) || NOTICE_TITLE_RE.test(v.title),
    }))
    .sort((a, b) => b.articleId - a.articleId); // 최신순

  console.log(
    `[Crawler] 목록 수집 완료 — 총 ${result.length}건 (공지 ${result.filter((r) => r.isNotice).length}건 포함)`
  );
  return result;
}

/**
 * 4-b. 카페 게시글 상세 수집 (로그인된 영속 Page 주입형 — 모바일 웹 우회)
 */
export async function scrapeCafeDetail(
  page: Page,
  clubId: string,
  articleId: number
): Promise<CafeArticleDetail | null> {
  const mobileUrl = `https://m.cafe.naver.com/ca-fe/web/cafes/${clubId}/articles/${articleId}`;
  console.log(`[Crawler] 상세 수집 중... Article ID: ${articleId}, URL: ${mobileUrl}`);

  try {
    try {
      await page.goto(mobileUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    } catch (navErr: any) {
      console.warn(`[Crawler] Article ${articleId} networkidle2 타임아웃 — 현재 DOM으로 파싱 진행:`, navErr?.message);
    }
    await sleepMs(2500);
    await injectEsbuildNameShim(page);

    const data = await page.evaluate(() => {
      // 1) 제목 파싱 (출처 등 숨김 텍스트 .blind 제거 가드 — 기존 scrapeArticleDetail 로직 동일)
      const titleEl = document.querySelector(
        '.ArticleTitle .title, .title_area .title, h2.title, h2.tit'
      );
      let title = '';
      if (titleEl) {
        const clone = titleEl.cloneNode(true) as HTMLElement;
        const blinds = clone.querySelectorAll('.blind, [class*="blind"], span.board_name, span.ellip, a.go_app, .tag');
        blinds.forEach((b) => b.remove());

        let parsedTitle = clone.innerText.trim() || clone.textContent?.trim() || '';

        if (parsedTitle) {
          parsedTitle = parsedTitle.replace(/^(공지|\[공지\])\s*/i, '');
          parsedTitle = parsedTitle.replace(/^\[실시간\s*핫딜\]\s*/i, '');
          parsedTitle = parsedTitle.replace(/^\[핫딜\]\s*/i, '');
          parsedTitle = parsedTitle.replace(/\s*[\(\[]?출처\s*:\s*[^\]\)]+[\)\]]?/g, '');
          parsedTitle = parsedTitle.replace(/\s*출처\s*:\s*\S+/g, '');
          parsedTitle = parsedTitle.replace(/\s*[\(\[]?재고\s*소량[\)\]]?/i, '');
          parsedTitle = parsedTitle.replace(/\s+/g, ' ').trim();
        }
        title = parsedTitle;
      }

      // 2) 본문 텍스트 및 이미지 추출 (기존 로직 동일)
      const contentEl = document.querySelector(
        '.se-viewer, .se-main-container, .ArticleContentBox, .article_viewer, #postContent'
      );
      let content = '';
      const imageUrls: string[] = [];

      if (contentEl) {
        const clone = contentEl.cloneNode(true) as HTMLElement;
        const blinds = clone.querySelectorAll('.blind, [class*="blind"]');
        blinds.forEach((b) => b.remove());

        let parsedContent = clone.innerText.trim() || clone.textContent?.trim() || '';

        if (parsedContent) {
          parsedContent = parsedContent.replace(/투표는\s*표시되지\s*않습니다\.?/gi, '');
          parsedContent = parsedContent.replace(/첨부파일\s*\d+\s*개/gi, '');
          parsedContent = parsedContent.split('\n').map(line => line.trim()).join('\n');
          parsedContent = parsedContent.replace(/\n{3,}/g, '\n\n').trim();
        }
        content = parsedContent;

        const imgs = contentEl.querySelectorAll('img');
        imgs.forEach((img) => {
          const src =
            img.getAttribute('data-lazy-src') ||
            img.getAttribute('src') ||
            '';
          if (
            src &&
            !src.includes('static.naver') &&
            !src.includes('blank.gif') &&
            src.startsWith('http')
          ) {
            imageUrls.push(src);
          }
        });
      } else {
        content = document.body.innerText;
      }

      // 3) 작성자 닉네임 — 폴백 체인
      // 실측(2026-06-12): 모바일 글 헤더는 .end_user_nick / a.nick / .user_wrap.
      // 주의: .nick_name 류 광역 셀렉터는 댓글 작성자까지 잡으므로 헤더 한정 셀렉터를 우선한다.
      let authorNickname = '';
      const nickEl = document.querySelector(
        '.end_user_nick, .user_wrap a.nick, a.nick, .profile_info .nickname, .WriterInfo .nickname, .user_info .nick, [class*="nickname"]'
      );
      if (nickEl) {
        authorNickname = (nickEl.textContent || '').replace(/\s+/g, ' ').trim();
      }

      // 4) 게시시각 원문 텍스트 — 폴백 체인 (파싱은 Node 측에서)
      let postedAtRaw = '';
      const dateEl = document.querySelector('.article_info .date, [class*="date"]');
      if (dateEl) {
        postedAtRaw = (dateEl.textContent || '').trim();
      }

      return { title, content, imageUrls, authorNickname, postedAtRaw };
    });

    if (!data.title) {
      console.warn(`[Crawler] Article ${articleId}의 제목을 파싱할 수 없어 스킵합니다.`);
      return null;
    }

    let { sourcePrice, fee } = parsePriceAndFee(data.content);
    if (sourcePrice === null) {
      // 본문에 가격이 없으면 제목에서 폴백 ("15000원!!", "20000>>10000원" 등) — 수수료는 0으로 간주
      const titlePrice = parsePriceFromTitle(data.title);
      if (titlePrice !== null) {
        sourcePrice = titlePrice;
        fee = 0;
      }
    }
    const postedAt = parsePostedAtText(data.postedAtRaw);
    const { sizes, colors } = parseOptions(data.title, data.content);

    return {
      articleId,
      title: data.title,
      content: data.content,
      imageUrls: data.imageUrls,
      authorNickname: data.authorNickname,
      postedAt,
      sourcePrice,
      fee,
      sizes,
      colors,
    };
  } catch (error) {
    console.error(`[Crawler] Article ${articleId} 상세 정보 수집 실패:`, error);
    return null;
  }
}
