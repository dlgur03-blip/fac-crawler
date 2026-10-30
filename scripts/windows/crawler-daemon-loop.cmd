@echo off
rem ============================================================
rem FACTORIES 크롤러 데몬 무한 재시작 래퍼 (윈도우용)
rem - 데몬이 죽으면 10초 후 자동 재시작
rem - 로그: 프로젝트 루트의 crawler-daemon.log
rem - 작업 스케줄러(install-crawler-task.ps1)가 로그온 시 이 파일을 실행
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0..\.."

rem ── 통합 모드 안전장치 (2026-10-31) ──────────────────────────
rem 루트에 .unified-mode 파일이 있으면 이 래퍼는 아무것도 하지 않는다.
rem 수집·재업을 한 프로세스(통합 데몬)로 합쳤는데, 옛 작업까지 같이 돌면
rem 같은 네이버 계정으로 여러 기기에서 접속하는 모양이 되어 보호조치를 부른다.
rem 옛 구조로 되돌리려면 .unified-mode 파일을 지우면 된다.
if exist ".unified-mode" (
  echo [%date% %time%] 통합 모드 - 이 래퍼는 종료합니다 ^(.unified-mode 존재^) >> unified-daemon.log
  exit /b 0
)


:loop
echo [%date% %time%] ===== 크롤러 데몬 시작 ===== >> crawler-daemon.log
call npm run crawler-daemon >> crawler-daemon.log 2>&1
echo [%date% %time%] 데몬 종료됨 - 10초 후 자동 재시작 >> crawler-daemon.log
timeout /t 10 /nobreak >nul
goto loop
