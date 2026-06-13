import crypto from 'crypto';

/**
 * 카페 게시글 제목 정규화 (재게시/끌어올림 중복 판정용)
 * - 번호 프리픽스("22ㅡ1", "21-4"), 할인율("90프로"), 가격 토큰("9,900원") 제거
 * - 공백/특수문자 제거 후 소문자화
 */
export function normalizeTitle(raw: string): string {
  let t = raw.normalize('NFKC').toLowerCase();
  t = t.replace(/^\s*\d+\s*[ㅡ\-_.~]\s*\d*\s*/, '');          // 번호 프리픽스 "22ㅡ1", "21-4"
  t = t.replace(/\d+\s*(프로|%)/g, '');                        // 할인율 "90프로"
  t = t.replace(/\d{1,3}(,\d{3})+원?|\d+원/g, '');             // 가격 토큰 "9900원"
  t = t.replace(/[^0-9a-z가-힣]/g, '');                        // 공백·특수문자 제거
  return t;
}

/**
 * 정규화 제목 + 상품금액 기반 32자 dedup 키 생성
 */
export function buildDedupKey(title: string, sourcePrice: number): string {
  return crypto.createHash('sha256').update(`${normalizeTitle(title)}|${sourcePrice}`).digest('hex').slice(0, 32);
}
