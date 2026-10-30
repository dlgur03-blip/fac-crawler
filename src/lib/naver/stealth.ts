/**
 * 네이버용 자동화 흔적 줄이기 (2026-10-02 신설 / 2026-10-30 입력 동작 전면 교체)
 *
 * 배경: 카페 계정 비밀번호가 바뀐 뒤 재로그인을 시도했는데, 캡차를 통과해도
 * "다시 로그인해 주세요"로 되돌아오며 로그인이 되지 않았다. 점검해 보니 데몬 브라우저가
 * 자동화라고 스스로 알리고 있었다.
 *
 *   1) `--enable-automation` — puppeteer가 기본으로 붙인다. navigator.webdriver 가 true 가 되고
 *      "자동화 소프트웨어가 제어 중" 띠까지 뜬다. 각 launch()에서 ignoreDefaultArgs로 뺀다.
 *   2) 가짜 UA — 기존 코드는 '맥 크롬 120'으로 위장했으나 실제는 윈도우 크롬이다.
 *      플랫폼·폰트·WebGL은 전부 윈도우라고 답하므로, 이 조합은 평범한 브라우저보다 오히려
 *      더 눈에 띈다. UA는 덮어쓰지 않고 진짜 값을 쓴다.
 *   3) 로그인 입력을 JS로 value에 꽂아 넣었다. 키 이벤트가 하나도 발생하지 않아
 *      "사람이 친 흔적"이 비어 있다. humanType으로 실제 키 입력을 만든다.
 *
 * 2026-10-30 추가 — 키 입력은 있었지만 여전히 기계적이었다. 사람과 다른 지점이 넷이었다.
 *
 *   a) 커서가 순간이동했다. page.click()은 마우스를 목표 좌표로 한 번에 놓고 누른다.
 *      사람은 궤적을 그리며 다가가고, 멀면 살짝 지나쳤다가 되돌아온다.
 *   b) 항상 요소의 **정중앙**을 찍었다. 같은 칸을 열 번 눌러 좌표가 소수점까지 동일하면
 *      사람일 수 없다.
 *   c) 글자 간격이 균등분포(70~180ms)였다. 사람의 간격은 종 모양이고, 시프트가 필요한
 *      글자에서 길어지고, 중간중간 멈춘다.
 *   d) 키를 **누르고 있는 시간**이 없었다. keydown과 keyup이 사실상 동시였다.
 *
 * 그리고 입력 후 **되읽어 검증**한다. 이게 실질적으로 더 중요하다 — 한 글자라도 빠진 채
 * 제출하면 그건 로그인 실패 1회로 집계되고, 실패 누적이 바로 계정 보호조치의 원인이다.
 *
 * ⚠️ 이 파일은 supabase 등 외부 의존을 import하지 않는다. 데몬이 .env.local을 읽기 전에
 *    정적 import가 먼저 실행되는데, 모듈 로드 시점에 클라이언트를 만드는 모듈을 끌어오면
 *    "supabaseUrl is required"로 기동 즉시 크래시한다. 순수 함수만 둔다.
 *
 * ⚠️ 이 모듈은 캡차나 기기확인을 풀지 않는다. 그건 사람이 해야 하고, 자동화하면 계정을 잃는다.
 *    여기서 하는 일은 "우리가 보내는 입력이 기계처럼 보이지 않게" 하는 것까지다.
 */

import type { Page } from 'puppeteer';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, Math.round(ms))));
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1));

/**
 * 정규분포 근사(Box–Muller).
 * 사람의 시간 간격은 균등분포가 아니라 평균 주변에 몰린 종 모양이다.
 * 균등 난수를 쓰면 "무작위인 것이 너무 고르게 무작위"라 오히려 패턴이 된다.
 */
function gauss(mean: number, sd: number, min: number, max: number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.min(max, Math.max(min, mean + z * sd));
}

/** 페이지별 마지막 커서 위치 — 다음 이동의 출발점이 된다 */
const cursorAt = new WeakMap<Page, { x: number; y: number }>();

/**
 * 평범한 브라우저처럼 보이게 하는 패치.
 * 문서가 만들어지는 시점에 적용되므로 페이지 이동 후에도 유지된다.
 * newPage() 직후, 첫 goto() 전에 호출해야 한다.
 */
export async function applyStealth(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    // puppeteer가 심는 자동화 표식
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // 한국어 사용자로 보이게 (네이버는 Accept-Language와 함께 본다)
    Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
    // 헤드리스 크롬은 plugins가 비어 있다 — 비어 있는 것 자체가 신호다
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    // 일반 크롬에는 window.chrome이 있다
    if (!(window as unknown as { chrome?: unknown }).chrome) {
      (window as unknown as { chrome: unknown }).chrome = { runtime: {} };
    }
  });

  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' });

  // 커서 초기 위치를 매번 다르게 둔다 (항상 0,0에서 출발하면 그 자체가 흔적이다)
  const vp = page.viewport();
  cursorAt.set(page, {
    x: rand(60, Math.max(200, (vp?.width ?? 1280) - 60)),
    y: rand(60, Math.max(200, (vp?.height ?? 800) - 60)),
  });
}

/**
 * 사람처럼 마우스를 옮긴다 — 궤적을 그리고, 멀면 살짝 지나쳤다가 되돌아온다.
 * page.mouse.move(steps)는 직선 보간이지만, 중간 지점을 흔들어 직선성을 깬다.
 */
async function moveTo(page: Page, x: number, y: number): Promise<void> {
  const from = cursorAt.get(page) ?? { x: rand(100, 600), y: rand(100, 500) };
  const dist = Math.hypot(x - from.x, y - from.y);

  if (dist > 40) {
    // 출발점과 목표 사이에서 한 번 꺾는다 (사람의 손은 직선으로 가지 않는다)
    const t = rand(0.35, 0.65);
    const sway = Math.min(60, dist * 0.12);
    const midX = from.x + (x - from.x) * t + rand(-sway, sway);
    const midY = from.y + (y - from.y) * t + rand(-sway, sway);
    await page.mouse.move(midX, midY, { steps: Math.max(4, Math.round(dist / 26)) });
    await sleep(gauss(28, 12, 8, 70));
  }

  if (dist > 160) {
    // 과조준 후 복귀 — 멀리 이동할 때 사람에게 거의 항상 나타난다
    await page.mouse.move(x + rand(-13, 13), y + rand(-9, 9), {
      steps: Math.max(6, Math.round(dist / 18)),
    });
    await sleep(gauss(52, 20, 18, 120));
    await page.mouse.move(x, y, { steps: randInt(3, 7) });
  } else {
    await page.mouse.move(x, y, { steps: Math.max(5, Math.round(dist / 9)) });
  }

  cursorAt.set(page, { x, y });
}

/**
 * 사람처럼 클릭한다.
 *
 * 1) 요소를 화면 안으로 가져온 뒤 **그 순간의** 좌표를 읽는다
 * 2) 정중앙이 아닌, 요소 안쪽의 임의 지점을 고른다
 * 3) 궤적을 그리며 이동 → 잠깐 머무름 → 누름(유지 시간 있음) → 뗌
 *
 * 요소를 못 찾거나 크기가 0이면 false. 호출한 쪽에서 폴백을 정하게 둔다.
 */
export async function humanClick(page: Page, selector: string): Promise<boolean> {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, selector);

  if (!box) return false;

  // 가운데를 정확히 찍는 사람은 없다 — 안쪽 60% 영역의 임의 지점
  const x = box.x + box.w * rand(0.2, 0.8);
  const y = box.y + box.h * rand(0.25, 0.75);

  await moveTo(page, x, y);
  await sleep(gauss(95, 45, 30, 280)); // 누르기 전 머무는 시간
  await page.mouse.down();
  await sleep(gauss(68, 24, 32, 165)); // 누르고 있는 시간
  await page.mouse.up();
  return true;
}

/**
 * 입력칸을 사람처럼 비운다 (Ctrl+A → Backspace).
 *
 * 예전 코드는 JS로 `el.value = ''`를 했다. 값은 비워지지만 키 이벤트가 없어
 * "지운 흔적"이 남지 않고, 프레임워크가 보는 상태와 어긋날 수도 있다.
 */
export async function humanClearField(page: Page, selector: string): Promise<void> {
  const needsClear = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLInputElement | null;
    return !!el && el.value.length > 0;
  }, selector);
  if (!needsClear) return;

  if (!(await humanClick(page, selector))) {
    await page.focus(selector).catch(() => {});
  }
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

/** 시프트를 눌러야 나오는 글자 — 사람은 여기서 느려진다 */
const SHIFTED = /[A-Z!@#$%^&*()_+{}|:"<>?~]/;

/**
 * 사람처럼 타이핑하고, **넣은 값이 맞는지 되읽어 확인한다**.
 *
 * - 글자 간격: 종 모양 분포. 시프트 글자에서 길어지고, 드물게 생각하는 멈춤이 끼어든다
 * - 키 유지 시간: keydown과 keyup 사이에 실제 간격을 둔다
 * - 붙여넣기(clipboard/execCommand/insertText)는 쓰지 않는다. 전부 실제 키 입력이다
 *
 * @returns 입력 길이가 기대와 같으면 true. 값 자체는 어디에도 기록하지 않는다.
 */
export async function humanType(page: Page, selector: string, text: string): Promise<boolean> {
  if (!(await humanClick(page, selector))) {
    await page.focus(selector).catch(() => {});
  }
  // 칸을 누르고 바로 치기 시작하지 않는다
  await sleep(gauss(280, 110, 90, 650));

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // keyboard.type은 글자 하나에 대해 down → (delay) → up 을 수행한다.
    // 여기서의 delay가 '키를 누르고 있는 시간'이 된다.
    await page.keyboard.type(ch, { delay: Math.round(gauss(62, 19, 28, 125)) });

    let gap = gauss(108, 40, 42, 270); // 다음 글자까지
    if (SHIFTED.test(ch)) gap += gauss(62, 26, 18, 160); // 시프트 조합은 느리다
    if (i > 1 && Math.random() < 0.07) gap += gauss(330, 150, 110, 820); // 잠깐 멈춤
    await sleep(gap);
  }

  const typedLength = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLInputElement | null;
    return el ? el.value.length : -1;
  }, selector);

  if (typedLength !== text.length) {
    // 값은 절대 로그에 남기지 않는다. 길이만 보고한다.
    console.warn(
      `[Stealth] 입력 검증 실패 ${selector} — 기대 ${text.length}자, 실제 ${typedLength}자`
    );
    return false;
  }
  return true;
}

/**
 * 페이지에 도착해서 바로 입력하지 않는다 — 사람은 화면을 한 번 본다.
 * 마우스를 조금 움직이고, 때로 살짝 스크롤한다.
 */
export async function humanSettle(page: Page, minMs = 900, maxMs = 2600): Promise<void> {
  await sleep(rand(minMs, maxMs));

  const vp = page.viewport();
  const w = vp?.width ?? 1280;
  const h = vp?.height ?? 800;

  if (Math.random() < 0.7) {
    await moveTo(page, rand(w * 0.15, w * 0.85), rand(h * 0.15, h * 0.8));
    await sleep(gauss(200, 90, 60, 500));
  }

  if (Math.random() < 0.35) {
    await page.evaluate(() => window.scrollBy(0, 30 + Math.random() * 110));
    await sleep(gauss(380, 150, 150, 800));
    // 원위치로 되돌린다 — 입력칸 좌표 계산은 클릭 직전에 다시 하므로 안전하지만,
    // 폼이 화면 밖으로 밀려나간 상태를 남기지 않는다.
    await page.evaluate(() => window.scrollTo({ top: 0 }));
    await sleep(gauss(260, 110, 100, 600));
  }
}
