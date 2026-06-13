# FACTORIES 크롤러 데몬 (fac-crawler)

네이버 카페(팩토리 구매대행, clubId 28310071)의 상품 글을 10분 주기로 크롤링해 jinshopping.com 쇼핑몰(Supabase)에 자동 등록하는 상주 데몬입니다. **항시 켜둔 윈도우 미니PC에서 돌리는 용도**의 독립 레포이며, 쇼핑몰 본체 코드는 `fac` 레포에 있습니다.

> 🤖 **Claude Code로 설치하는 경우**: 이 폴더에서 Claude Code를 열고 "README대로 설치하고 작업 스케줄러까지 등록해줘"라고 하면 됩니다. 사람이 직접 할 일은 `.env.local` 넣기와 첫 로그인 캡차 풀기 정도입니다.

---

## 윈도우 미니PC 설치 (15분)

### 0. 준비물
- 윈도우 10/11 + 인터넷
- 운영 `.env.local` 파일 (맥 프로젝트에서 복사 — **공개 채널로 전송 금지**)

### 1. Node.js
https://nodejs.org → **LTS** 설치 (기본값). 확인: cmd에서 `node -v`

### 2. 프로젝트 받기
```cmd
cd %USERPROFILE%
git clone https://github.com/dlgur03-blip/fac-crawler.git
cd fac-crawler
npm install
```
(git 없으면 https://git-scm.com 설치 후 cmd 새로 열기. `npm install`은 Puppeteer 크롬 다운로드로 몇 분 소요)

### 3. 환경변수
`.env.local` 파일을 `fac-crawler` 폴더 바로 안에 넣기. (`.env.example`은 키 이름 안내용 — 값은 운영 파일에서)
탐색기 확장자 숨김 때문에 `.env.local.txt`가 되지 않게 주의.

### 4. 첫 실행 — 네이버 로그인 (창 띄워서)
새 기기 첫 로그인은 캡차/기기확인이 뜰 수 있으므로 처음 한 번은 창을 보면서:
```cmd
cd %USERPROFILE%\fac-crawler
set NAVER_HEADLESS=false
npm run crawler-daemon
```
- 캡차가 뜨면 그 크롬 창에서 직접 풀기. 통과하면 세션이 `.naver_profile`에 저장돼 다시 안 물어봄.
- `🟢 데몬 시작` + `네이버 로그인 성공!` 확인 후 `Ctrl+C` 종료.

### 5. 자동 시작 등록
**관리자 PowerShell**(시작 우클릭 → 터미널(관리자)):
```powershell
cd $env:USERPROFILE\fac-crawler\scripts\windows
Set-ExecutionPolicy -Scope Process Bypass -Force
.\install-crawler-task.ps1
```
→ 로그온 시 자동 시작 + 데몬 크래시 시 10초 후 재시작 + 래퍼 크래시 시 1분 후 재시작.

### 6. PC 설정 (필수)
1. **자동 로그인**: `Win+R` → `netplwiz` → "사용자가 이 컴퓨터를 사용하려면..." 체크 해제 → 비밀번호 입력 (재부팅→자동로그온→데몬 자동시작 체인 완성)
2. **절전 금지**: 설정 → 시스템 → 전원 → 절전 "안 함" (화면 끄기는 무관)

### 7. 확인
- 로그: `notepad %USERPROFILE%\fac-crawler\crawler-daemon.log` — `✅ 완료 (job ...)` 누적되면 정상
- 원격: 쇼핑몰 관리자 → 상품 관리 → "카페 동기화 🔄" → 몇 분 내 완료 메시지
- 재부팅 테스트: 재부팅 후 2~3분 내 로그에 새 `🟢` 줄

### 8. 기존 머신 데몬 끄기 (이중 크롤 방지)
맥에서: `pkill -f naver-crawler-daemon`

---

## 관리 명령 (관리자 PowerShell)
| 작업 | 명령 |
|---|---|
| 시작 | `Start-ScheduledTask -TaskName "FACTORIES-CrawlerDaemon"` |
| 중지 | `Stop-ScheduledTask -TaskName "FACTORIES-CrawlerDaemon"` 후 `taskkill /f /im node.exe` |
| 제거 | `Unregister-ScheduledTask -TaskName "FACTORIES-CrawlerDaemon" -Confirm:$false` |
| 업데이트 | `git pull && npm install` 후 중지→시작 |

## 동작 개요
- 15초마다 Supabase `crawl_queue` 폴링 (관리자 "카페 동기화" 버튼 = MANUAL 작업)
- 10분마다 자동 SCHEDULED 크롤 (최신 200글, 공지 제외, 글ID 멱등, dedup 재게시 처리)
- 링크 끌어올림 글은 원본 추적해 가격/이미지 회수, 제목 품절 표기 자동 감지
- 실패 글은 상품 미생성 + `crawl_queue.result.warnings`에 로그 (가격 오인 방지 보수 설계)

## 코드 수정은 어디서?
**원본은 `fac` 레포** (`src/lib/naver/*`, `scripts/naver-crawler-daemon.ts`). 파서 보정 등 수정은 fac에서 하고, fac의 `scripts/sync-crawler-repo.sh`로 이 레포에 동기화합니다. 이 레포를 직접 고치면 다음 동기화 때 덮어써집니다.
