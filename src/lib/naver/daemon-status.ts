/**
 * 데몬 생존·상태 보고 (2026-07-30)
 *
 * 기존에는 데몬 생존 신호가 작업 행(crawl_queue/posting_queue.updated_at)에만 남아서
 * 큐가 비어 있으면 데몬이 살아있는지조차 알 수 없었다(2026-07-30 "포스터 안 되나?" 사건).
 * 여기서는 idle 상태에서도 daemon_status 행을 갱신해 관리자 화면이 생존을 판정할 수 있게 한다.
 *
 * 크롤러·포스터 데몬 공용. 절대 throw하지 않는다 — 상태 보고 실패가 본작업을 막으면 안 된다.
 */
import os from 'os';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export type DaemonName = 'poster' | 'crawler';
export type DaemonState = 'IDLE' | 'WORKING' | 'LOGIN_REQUIRED' | 'ERROR';

export interface DaemonStatusReport {
  name: DaemonName;
  state: DaemonState;
  /** 마지막 에러 문구 (500자 truncate) */
  lastError?: string | null;
  /** 자유 형식 부가정보 — 진행률·진단 stage·스크린샷 경로 등 */
  detail?: Record<string, unknown> | null;
  /** true면 consecutive_failures +1 */
  bumpFailure?: boolean;
  /** true면 last_success_at=now + consecutive_failures=0 */
  markSuccess?: boolean;
  /** true면 last_login_check_at=now (세션 주기 갱신 성공 시) */
  markLoginCheck?: boolean;
}

let client: SupabaseClient | null = null;
function getClient(): SupabaseClient | null {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

export async function reportDaemonStatus(report: DaemonStatusReport): Promise<void> {
  const sb = getClient();
  if (!sb) return;

  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    name: report.name,
    state: report.state,
    host: os.hostname(),
    pid: process.pid,
    last_heartbeat: now,
    updated_at: now
  };

  if (report.lastError !== undefined) {
    row.last_error = report.lastError ? String(report.lastError).slice(0, 500) : null;
  }
  if (report.detail !== undefined) row.detail = report.detail;
  if (report.markSuccess) {
    row.last_success_at = now;
    row.consecutive_failures = 0;
  }
  if (report.markLoginCheck) row.last_login_check_at = now;

  try {
    if (report.bumpFailure) {
      // 누적 실패 횟수는 현재값을 읽어 +1 (RPC 없이 처리 — 데몬은 단일 프로세스라 경합 없음)
      const { data: existing } = await sb
        .from('daemon_status')
        .select('consecutive_failures')
        .eq('name', report.name)
        .maybeSingle();
      row.consecutive_failures = (existing?.consecutive_failures ?? 0) + 1;
    }

    const { error } = await sb.from('daemon_status').upsert(row, { onConflict: 'name' });
    if (error) console.warn(`[DaemonStatus] ${report.name} 상태 기록 실패:`, error.message);
  } catch (err: any) {
    console.warn(`[DaemonStatus] ${report.name} 상태 기록 예외:`, err?.message || err);
  }
}
