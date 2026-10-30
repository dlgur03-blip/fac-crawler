/**
 * 카페 작성자 닉네임 정리 (2026-10-23 신설)
 *
 * 2026-10-14부터 카페가 글 상세에서 닉네임 뒤에 **직함**을 붙여 내려주기 시작했다.
 *   "굿걸스텝"       → "굿걸스텝 카페스탭"
 *   "핫딜매니저"     → "핫딜매니저 카페매니저"
 * 크롤러가 그 덩어리를 통째로 author_nickname 에 저장하면서 두 가지가 한꺼번에 깨졌다.
 *
 *   ① **차단 작성자가 뚫렸다.** 차단은 정확 일치로 판정한다(DB 트리거
 *      trg_reject_blocked_author, 크롤 데몬의 blockedAuthors, 그리고 상품상세·체크아웃·
 *      주문생성·관리자목록의 '굿걸스텝' 비교 5곳). 글자가 달라지니 전부 통과했다.
 *      실측: 굿걸스텝 86건 / 태양스텝 216건이 몰에 적재되고 고객 주문까지 가능한 상태였다.
 *   ② **셀러 매칭이 끊겼다.** managers.cafe_nickname='핫딜매니저' 와 안 맞아
 *      manager_id 가 비었다(398건).
 *
 * 그래서 저장 직전에 직함을 떼어 **카페에 보이는 순수 닉네임만** 남긴다.
 *
 * ⚠️ 공백 뒤를 무조건 자르면 안 된다 — "나의 루루"처럼 공백이 든 닉네임이 실제로 있다.
 *    알려진 직함이 **끝에 붙은 경우만** 떼어낸다.
 */

/**
 * 닉네임 끝에 붙는 카페 직함.
 * '핫딜매니저'처럼 닉네임 자체에 '매니저'가 들어간 경우를 깨뜨리지 않도록
 * **앞에 공백이 있을 때만** 직함으로 본다.
 */
const CAFE_ROLE_SUFFIX = /\s+(?:카페\s*매니저|카페\s*스탭|카페\s*스태프|부\s*매니저|매니저|스탭|스태프|staff|manager)\s*$/i;

/**
 * 카페 닉네임에서 직함을 떼어낸다.
 * 직함이 여러 번 붙는 경우("핫딜매니저 카페 매니저")도 끝까지 걷어낸다.
 */
export function normalizeCafeNickname(raw: string | null | undefined): string {
  let s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return '';

  // 직함을 반복해 떼되, 전부 떼어 빈 문자열이 되면 되돌린다
  for (let i = 0; i < 3; i++) {
    const next = s.replace(CAFE_ROLE_SUFFIX, '').trim();
    if (next === s) break;
    if (!next) break; // 닉네임이 '매니저' 자체인 경우 — 원본 유지
    s = next;
  }
  return s;
}

/**
 * 몰에 노출하지 않는 셀러 (대표님 지시).
 *
 * 크롤 단계는 DB의 `crawl_blocked_authors` 를 읽어 막지만, 웹(상품상세·체크아웃·
 * 주문생성·관리자목록)은 DB를 거치지 않고 판정해야 해서 여기 둔다. 양쪽이 어긋나지
 * 않도록 **차단 셀러를 추가할 때는 DB 테이블과 이 상수를 함께** 고쳐야 한다.
 *
 * 2026-10-23: 그전까지 각 화면이 `=== '굿걸스텝'` 로 직접 비교했는데, 카페가 닉네임 뒤에
 * 직함을 붙이기 시작하자("굿걸스텝 카페스탭") 5곳이 한꺼번에 뚫려 86건이 몰에 올라왔다.
 */
export const BLOCKED_SELLERS = ['굿걸스텝', '태양스텝'] as const;

/**
 * 차단 작성자인지 — 양쪽을 정규화해 비교한다.
 *
 * 직함뿐 아니라 **등급 표기**도 붙는다(운영 DB에 "동글이222 새싹멤버"가 있다).
 * 등급 이름은 카페지기가 자유롭게 정해서 목록으로 못 막는다. 그래서 직함을 뗀 뒤에도
 * 안 맞으면 **첫 토큰**으로 한 번 더 본다 — "굿걸스텝 ○○○" 은 전부 굿걸스텝이다.
 *
 * 차단은 과하게 거는 쪽이 안전하다. 대표님이 지목해 제외한 셀러이고, 한 건이라도
 * 새면 그 상품이 몰에 올라가 손님이 주문한다(2026-10-23에 실제로 86건이 그랬다).
 * 첫 토큰이 통째로 같아야 하므로 "굿걸스텝맘" 같은 다른 사람은 걸리지 않는다.
 */
export function isBlockedAuthor(
  authorNickname: string | null | undefined,
  blocked: Iterable<string>
): boolean {
  const name = normalizeCafeNickname(authorNickname);
  if (!name) return false;

  const firstToken = name.split(' ')[0];
  for (const b of blocked) {
    const bn = normalizeCafeNickname(b);
    if (!bn) continue;
    if (bn === name) return true;
    if (bn === firstToken) return true;
  }
  return false;
}
