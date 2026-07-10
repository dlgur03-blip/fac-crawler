@echo off
rem ============================================================
rem FACTORIES 포스팅(재업/신규) 데몬 무한 재시작 래퍼 (윈도우용)
rem - 데몬이 죽으면 10초 후 자동 재시작
rem - 로그: 프로젝트 루트의 poster-daemon.log
rem - 작업 스케줄러(install-poster-task.ps1)가 로그온 시 이 파일을 실행
rem - 크롤러 데몬과 프로필 디렉토리가 분리돼 있어 동시 가동 가능
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0..\.."

:loop
echo [%date% %time%] ===== 포스팅 데몬 시작 ===== >> poster-daemon.log
call npm run naver-daemon >> poster-daemon.log 2>&1
echo [%date% %time%] 데몬 종료됨 - 10초 후 자동 재시작 >> poster-daemon.log
timeout /t 10 /nobreak >nul
goto loop
