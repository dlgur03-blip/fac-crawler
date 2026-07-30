/**
 * 데몬 실패 진단 스크린샷 업로드 (2026-07-30)
 *
 * 기존에는 uploader가 실패 스크린샷을 cwd의 고정 파일명(error_screenshot.png)으로 저장해서
 * 매 실패마다 덮어써지고 원격(맥)에서 볼 수 없었다. 여기서는 비공개 버킷에 시각별 경로로
 * 올려서 관리자 화면이 signed URL로 열 수 있게 한다.
 *
 * 버킷은 반드시 비공개(public:false) — 로그인 화면 스크린샷에 계정 정보가 찍힐 수 있으므로
 * 공개 버킷(products/documents)에는 절대 올리지 않는다.
 *
 * 이 모듈은 절대 throw하지 않는다. 진단 실패가 본작업(포스팅)을 막으면 안 된다.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export const DIAGNOSTICS_BUCKET = 'daemon-diagnostics';

function getServiceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/** KST 기준 yyyyMMdd / HHmmss 문자열 (데몬이 어느 타임존에 있어도 한국 시각으로 정렬되게) */
function kstStamp(): { day: string; time: string } {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    day: `${kst.getUTCFullYear()}${p(kst.getUTCMonth() + 1)}${p(kst.getUTCDate())}`,
    time: `${p(kst.getUTCHours())}${p(kst.getUTCMinutes())}${p(kst.getUTCSeconds())}`
  };
}

/**
 * 스크린샷 버퍼를 비공개 버킷에 업로드하고 저장 경로를 반환한다.
 * @param buffer  page.screenshot({ type:'jpeg', quality:70 }) 결과
 * @param daemon  'poster' | 'crawler'
 * @param label   실패 단계 등 파일명에 남길 라벨 (영문/숫자/하이픈 권장)
 * @returns 버킷 내 경로 (실패 시 null)
 */
export async function uploadDiagnosticScreenshot(
  buffer: Buffer | Uint8Array,
  daemon: 'poster' | 'crawler',
  label: string
): Promise<string | null> {
  const sb = getServiceClient();
  if (!sb) {
    console.warn('[Diagnostics] Supabase 환경변수 누락 — 스크린샷 업로드 스킵');
    return null;
  }

  const { day, time } = kstStamp();
  const safeLabel = String(label || 'unknown').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40);
  const objectPath = `${daemon}/${day}/${time}-${safeLabel}.jpg`;

  const doUpload = () =>
    sb.storage.from(DIAGNOSTICS_BUCKET).upload(objectPath, buffer, {
      contentType: 'image/jpeg',
      upsert: true
    });

  try {
    let { error } = await doUpload();

    // 버킷이 없으면 비공개로 생성 후 1회 재시도
    // (api/products/upload-image의 자동생성 패턴과 동일하되 public만 반대)
    if (error) {
      const { error: createErr } = await sb.storage.createBucket(DIAGNOSTICS_BUCKET, {
        public: false,
        fileSizeLimit: 5 * 1024 * 1024
      });
      if (createErr && !/already exists/i.test(createErr.message)) {
        console.warn('[Diagnostics] 버킷 생성 실패:', createErr.message);
        return null;
      }
      ({ error } = await doUpload());
    }

    if (error) {
      console.warn('[Diagnostics] 스크린샷 업로드 실패:', error.message);
      return null;
    }

    console.log(`[Diagnostics] 진단 스크린샷 업로드 완료: ${objectPath}`);
    return objectPath;
  } catch (err: any) {
    console.warn('[Diagnostics] 스크린샷 업로드 예외:', err?.message || err);
    return null;
  }
}
