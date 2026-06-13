@echo off
rem ============================================================
rem FACTORIES 크롤러 데몬 무한 재시작 래퍼 (윈도우용)
rem - 데몬이 죽으면 10초 후 자동 재시작
rem - 로그: 프로젝트 루트의 crawler-daemon.log
rem - 작업 스케줄러(install-crawler-task.ps1)가 로그온 시 이 파일을 실행
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0..\.."

:loop
echo [%date% %time%] ===== 크롤러 데몬 시작 ===== >> crawler-daemon.log
call npm run crawler-daemon >> crawler-daemon.log 2>&1
echo [%date% %time%] 데몬 종료됨 - 10초 후 자동 재시작 >> crawler-daemon.log
timeout /t 10 /nobreak >nul
goto loop
