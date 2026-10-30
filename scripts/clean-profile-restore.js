/**
 * 크롬 프로필의 "세션 복원" 상태를 정리한다. (2026-10-31 신설)
 *
 * ## 왜 필요한가
 *
 * 데몬이 강제 종료되면(taskkill / 래퍼 재시작 / 크래시) 크롬이 정상 종료 플래그를 남기지
 * 못한다. 다음 실행에서 크롬은 이를 크래시로 보고 **이전 탭을 전부 복원**한다.
 *
 *   2026-10-02  18개 복원 → CDP 호출이 타임아웃으로 죽음
 *   2026-10-30   3개 복원 → 같은 자리에서 또 막힘
 *   2026-10-31  29개 복원 → `Attempted to use detached Frame` 으로 로그인 스크립트 실패
 *                           + 화면에 창이 잔뜩 떠서 "브라우저를 계속 연다"고 보였다
 *
 * 세 번 반복됐다. 탭을 닫는 대응(사후)만으로는 부족하고 **복원 자체를 막아야**(사전) 한다.
 *
 * ## 무엇을 하는가
 *
 *   1) `Default/Sessions/`, `Default/Last Session`, `Default/Last Tabs` 등 복원 데이터 삭제
 *   2) `Default/Preferences` 의 `exit_type`을 `Normal`, `exited_cleanly`를 `true` 로 고침
 *
 * 쿠키·로그인 세션은 `Default/Network/Cookies` 에 있고 여기서 건드리지 않는다.
 * **로그인은 유지된다.**
 *
 * ## 사용법
 *
 *     node scripts/clean-profile-restore.js            # .naver_profile
 *     node scripts/clean-profile-restore.js poster     # .naver_profile_poster
 *     node scripts/clean-profile-restore.js <경로>
 *
 * ⚠️ 해당 프로필로 크롬이 떠 있는 상태에서 실행하지 마라. 먼저 데몬을 멈춰야 한다.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const log = (s) => process.stdout.write(s + '\n');

/**
 * 폴더/파일을 지운다.
 *
 * ⚠️ `fs.rmSync` 로 이 프로필 하위 폴더를 지우면 이 환경에서 **노드 프로세스가 종료코드 127로
 * 급사**한다(2026-10-31 확인. 버퍼에 남은 stdout까지 유실돼 어디서 죽었는지도 안 보였다).
 * 그래서 PowerShell `Remove-Item` 으로 지운다 — 같은 작업이 정상 동작한다.
 */
function removeHard(target) {
  if (process.platform === 'win32') {
    // PowerShell 문자열 안에 경로를 직접 넣는다. `-Command ... -args` 조합은 $args 가
    // 채워지지 않아 LiteralPath 가 null 이 된다(2026-10-31에 그렇게 실패했다).
    // 작은따옴표 문자열이라 공백·한글 경로가 안전하고, 내부 작은따옴표만 두 번으로 escape 한다.
    const quoted = "'" + String(target).replace(/'/g, "''") + "'";
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Remove-Item -LiteralPath ${quoted} -Recurse -Force -ErrorAction Stop`],
      { stdio: 'pipe' }
    );
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function resolveProfile(arg) {
  const ROOT = process.cwd();
  if (!arg || arg === 'crawler') return path.join(ROOT, '.naver_profile');
  if (arg === 'poster') return path.join(ROOT, '.naver_profile_poster');
  return path.isAbsolute(arg) ? arg : path.join(ROOT, arg);
}

function main() {
  const profileDir = resolveProfile(process.argv[2]);

  if (!fs.existsSync(profileDir)) {
    log('프로필 없음: ' + profileDir);
    process.exitCode = 1;
    return;
  }

  log('■ 프로필: ' + profileDir);

  // 크롬이 이 프로필을 잡고 있으면 경고만 남긴다 (잔재 파일일 수도 있다)
  for (const lock of ['SingletonLock', 'lockfile']) {
    if (fs.existsSync(path.join(profileDir, lock))) {
      log('  ⚠️ ' + lock + ' 존재 — 크롬이 떠 있을 수 있습니다. 데몬을 먼저 멈추세요.');
    }
  }

  // ── 1) 복원 데이터 제거 ──
  const targets = [
    'Default/Sessions',
    'Default/Session Storage',
    'Default/Last Session',
    'Default/Last Tabs',
    'Default/Current Session',
    'Default/Current Tabs',
    'Sessions',
    'Last Session',
    'Last Tabs',
  ];
  let removed = 0;
  for (const rel of targets) {
    const p = path.join(profileDir, rel.replace(/\//g, path.sep));
    if (!fs.existsSync(p)) continue;
    try {
      const isDir = fs.statSync(p).isDirectory();
      removeHard(p);
      log('  삭제: ' + rel + (isDir ? '/' : ''));
      removed += 1;
    } catch (e) {
      log('  ⚠️ 삭제 실패 ' + rel + ': ' + (e && e.message));
    }
  }
  if (removed === 0) log('  복원 데이터 없음 (이미 깨끗함)');

  // ── 2) Preferences 의 종료 상태를 '정상'으로 ──
  const prefPath = path.join(profileDir, 'Default', 'Preferences');
  if (fs.existsSync(prefPath)) {
    try {
      const pref = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
      const beforeExit = pref.profile ? pref.profile.exit_type : undefined;
      const beforeClean = pref.profile ? pref.profile.exited_cleanly : undefined;
      pref.profile = pref.profile || {};
      pref.profile.exit_type = 'Normal';
      pref.profile.exited_cleanly = true;
      if (pref.session && pref.session.restore_on_startup === 1) {
        pref.session.restore_on_startup = 0; // 1=이전 세션 복원, 0=새 탭
        log('  session.restore_on_startup 1(이전 세션) → 0(새 탭)');
      }
      fs.writeFileSync(prefPath, JSON.stringify(pref), 'utf8');
      log('  Preferences: exit_type ' + beforeExit + ' → Normal / exited_cleanly ' + beforeClean + ' → true');
    } catch (e) {
      log('  ⚠️ Preferences 수정 실패: ' + (e && e.message));
    }
  } else {
    log('  Preferences 없음 (새 프로필)');
  }

  // ── 3) 쿠키가 그대로인지 확인 (로그인이 날아가지 않았음을 보이기 위해) ──
  const cookiePath = path.join(profileDir, 'Default', 'Network', 'Cookies');
  if (fs.existsSync(cookiePath)) {
    const kb = Math.round(fs.statSync(cookiePath).size / 1024);
    log('  쿠키 DB 유지: Default/Network/Cookies (' + kb + 'KB) — 로그인 세션은 건드리지 않았습니다');
  } else {
    log('  쿠키 DB 없음 — 로그인 상태가 아닙니다');
  }

  log('');
  log('✅ 다음 기동에서 탭이 복원되지 않습니다.');
}

try {
  main();
} catch (e) {
  console.error('정리 실패:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
}
