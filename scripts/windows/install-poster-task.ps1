# ============================================================
# FACTORIES 포스팅(재업/신규) 데몬 — 윈도우 작업 스케줄러 등록 스크립트
#
# 하는 일:
#   1) 로그온 시 poster-daemon-loop.cmd 자동 실행 작업 등록
#   2) 실행 시간 무제한 + 실패 시 1분 간격 재시작 설정
#   3) 등록 직후 즉시 1회 실행
#
# 사용법 (관리자 PowerShell):
#   cd <프로젝트폴더>\scripts\windows
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   .\install-poster-task.ps1
#
# 제거:
#   Unregister-ScheduledTask -TaskName "FACTORIES-PosterDaemon" -Confirm:$false
# ============================================================

$ErrorActionPreference = "Stop"
$TaskName = "FACTORIES-PosterDaemon"

# 프로젝트 루트 = 이 스크립트의 두 단계 위
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Wrapper = Join-Path $Root "scripts\windows\poster-daemon-loop.cmd"

if (-not (Test-Path $Wrapper)) {
  Write-Host "[오류] 래퍼를 찾을 수 없습니다: $Wrapper" -ForegroundColor Red
  exit 1
}
if (-not (Test-Path (Join-Path $Root ".env.local"))) {
  Write-Host "[오류] $Root\.env.local 이 없습니다. 맥에서 .env.local을 복사해 넣은 뒤 다시 실행하세요." -ForegroundColor Red
  exit 1
}

# 기존 작업이 있으면 교체
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "[안내] 기존 작업을 제거하고 다시 등록합니다."
}

$Action = New-ScheduledTaskAction -Execute $Wrapper -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -RunLevel Highest `
  -Description "FACTORIES 네이버 카페 포스팅(재업/신규) 데몬 (로그온 시 자동 시작, 크래시 시 자동 재시작)" | Out-Null

Write-Host "[완료] 작업 스케줄러 등록: $TaskName" -ForegroundColor Green

# 즉시 1회 실행
Start-ScheduledTask -TaskName $TaskName
Write-Host "[완료] 데몬을 즉시 시작했습니다. 로그 확인: $Root\poster-daemon.log" -ForegroundColor Green
Write-Host ""
Write-Host "다음을 꼭 확인하세요:"
Write-Host "  1) 첫 실행은 .env.local에 NAVER_HEADLESS=false 를 넣고 수동으로 npm run naver-daemon 실행 —"
Write-Host "     포스팅 계정(핫딜매니저) 첫 로그인 캡차/기기확인을 눈으로 풀어야 합니다. 성공 후 지우고 데몬 등록"
Write-Host "  2) NAVER_POST_CAFE_ID 미설정 = 테스트 카페(31729221)로 갑니다. 검증 후 28310071로 전환"
Write-Host "  3) 크롤러 데몬과 프로필이 분리(.naver_profile_poster)돼 있어 동시 가동 가능합니다"
