@echo off
rem ============================================================
rem FACTORIES 통합 데몬 무한 재시작 래퍼 (윈도우용)  2026-10-31 신설
rem
rem 수집(크롤)과 재업(끌올)을 한 프로세스에서 번갈아 돌린다.
rem 전에는 데몬이 둘이었고 각자 크롬 프로필을 갖고 같은 계정으로 따로 로그인했다.
rem 네이버 입장에서 한 아이디가 기기 두 대로 접속하는 모양이라 보호조치를 불렀다.
rem
rem - 데몬이 죽으면 10초 후 자동 재시작
rem - 크롬은 분리 실행(detached)이라 데몬이 죽어도 로그인된 창은 살아 있다
rem - 로그: 프로젝트 루트의 unified-daemon.log
rem - 작업 스케줄러(install-unified-task.ps1)가 로그온 시 이 파일을 실행
rem
rem 주의: 옛 작업(FACTORIES-CrawlerDaemon / FACTORIES-PosterDaemon)은 반드시 꺼야 한다.
rem       같이 돌면 같은 계정으로 세 군데서 접속하게 된다.
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0..\.."

:loop
echo [%date% %time%] ===== 통합 데몬 시작 (수집+재업) ===== >> unified-daemon.log
call npm run unified-daemon >> unified-daemon.log 2>&1
echo [%date% %time%] 데몬 종료됨 - 10초 후 자동 재시작 >> unified-daemon.log
timeout /t 10 /nobreak >nul
goto loop
