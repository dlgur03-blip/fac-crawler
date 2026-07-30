# FACTORIES 크롤러 + 포스팅 데몬 (fac-crawler)

네이버 카페(팩토리 구매대행, clubId 28310071)의 상품 글을 10분 주기로 크롤링해 jinshopping.com 쇼핑몰(Supabase)에 자동 등록하는 **크롤러 데몬**과, 관리자 페이지의 재업(끌올)/신규 등록 요청을 받아 카페에 글을 쓰는 **포스팅 데몬** 2개로 구성됩니다. **항시 켜둔 윈도우 미니PC에서 돌리는 용도**의 독립 레포이며, 쇼핑몰 본체 코드는 `fac` 레포에 있습니다.

| 데몬 | 실행 | 큐 | 역할 | 프로필 |
|---|---|---|---|---|
| 크롤러 | `npm run crawler-daemon` | `crawl_queue` | 카페 → 몰 (수집) | `.naver_profile` |
| 포스팅 | `npm run naver-daemon` | `posting_queue` | 몰 → 카페 (재업/신규 글쓰기) | `.naver_profile_poster` |

프로필 디렉토리가 분리돼 있어 **두 데몬 동시 가동 가능**합니다.

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

## 포스팅(재업/끌올) 데몬 설치

관리자 상품 대시보드에서 상품을 선택해 "재업 ♻️"을 누르면 `posting_queue`에 쌓이고, 이 데몬이 카페에 본문 통째로 새 글을 등록합니다.

### 1. 환경변수 추가 (`.env.local`)
```
# 포스팅 계정 (핫딜매니저 등 — 미설정 시 크롤러와 같은 NAVER_USER_ID 사용)
NAVER_POSTER_USER_ID=핫딜매니저_아이디
NAVER_POSTER_PW=핫딜매니저_비밀번호

# 포스팅 대상 카페 — 미설정 시 테스트 카페(31729221, 이혁의카페)
# 테스트 검증 후 실카페로 전환:
# NAVER_POST_CAFE_ID=28310071
```

### 2. 첫 실행 — 포스팅 계정 로그인 (창 띄워서)
```cmd
cd %USERPROFILE%\fac-crawler
set NAVER_HEADLESS=false
npm run naver-daemon
```
캡차/기기확인을 눈으로 풀면 세션이 `.naver_profile_poster`에 저장됩니다. `🟢 데몬 시작` 확인 후 `Ctrl+C`.

### 3. 자동 시작 등록 (관리자 PowerShell)
```powershell
cd $env:USERPROFILE\fac-crawler\scripts\windows
Set-ExecutionPolicy -Scope Process Bypass -Force
.\install-poster-task.ps1
```

### 4. 검증 순서
1. `NAVER_POST_CAFE_ID` **미설정**(=테스트 카페) 상태로 관리자에서 1~2건 재업 → 테스트 카페에 글 생김 + 큐 DONE 확인
2. `.env.local`에 `NAVER_POST_CAFE_ID=28310071` 추가 → 데몬 재시작 → 실카페 1건 재업 검증
3. 실카페 재업 성공 시 상품의 `cafe_article_id`가 새 글로 갱신돼 다음 크롤이 중복 수집하지 않음

### 관리 명령
| 작업 | 명령 |
|---|---|
| 시작/중지 | `Start-ScheduledTask`/`Stop-ScheduledTask -TaskName "FACTORIES-PosterDaemon"` |
| 제거 | `Unregister-ScheduledTask -TaskName "FACTORIES-PosterDaemon" -Confirm:$false` |
| 로그 | `notepad %USERPROFILE%\fac-crawler\poster-daemon.log` |

### 5. 세션 주기 점검 (2026-07-30 추가)
포스터는 재업 작업이 있을 때만 로그인하므로, 텀이 길어지면 네이버가 기기확인/캡차를 요구해
**정작 재업이 필요한 순간에 실패**한다. 이제 데몬이 기동 직후 + `SESSION_REFRESH_HOURS`(기본 6시간)
마다 세션을 점검하고, 깨졌으면 관리자 화면(`jinshopping.com/admin`)에 **"포스터 로그인 필요"** 로 표시한다.
- 로그인/캡차 차단으로 판정되면 재시도를 하지 않고 즉시 실패 처리한다(반복 로그인으로 계정을 더 자극하지 않기 위함).
- 실패 원인은 `posting_queue.result`에 단계(LOGIN/CAFE_ENTER/…/VERIFY)와 캡차·기기확인 여부로 남고,
  실패 화면 스크린샷은 비공개 버킷(`daemon-diagnostics`)에 올라가 관리자 화면에서 열어볼 수 있다.

## 포스터를 다른 PC로 이전하기

> ⚠️ **가장 중요: 새 PC를 켜기 전에 기존 PC의 포스터 태스크를 반드시 중지한다.**
> 두 대가 같은 큐를 폴링하면 먼저 집어간 쪽이 처리해버려 새 PC 검증이 불가능하다.

```powershell
# (기존 PC) 포스터만 중지 — 크롤러(FACTORIES-CrawlerDaemon)는 그대로 둔다
Stop-ScheduledTask   -TaskName "FACTORIES-PosterDaemon"
Disable-ScheduledTask -TaskName "FACTORIES-PosterDaemon"
```

1. 새 PC에 Node.js LTS + git 설치 → `git clone https://github.com/dlgur03-blip/fac-crawler.git` → `npm install`
2. `.env.local` 준비 — **기존 PC의 `%USERPROFILE%\fac-crawler\.env.local`을 파일째 복사**하는 것이 가장 안전하다
   (Supabase 키·포스팅 계정이 모두 들어있음). 메모장 저장 시 `.env.local.txt`가 되지 않게 주의.
3. 첫 로그인 — `set NAVER_HEADLESS=false` 후 `npm run naver-daemon`으로 창을 띄워 캡차/기기확인을 직접 통과
   (세션이 `.naver_profile_poster`에 저장됨). `🟢 데몬 시작` 확인 후 `Ctrl+C`
4. 테스트 카페로 1건 재업 검증 → `.env.local`에 `NAVER_POST_CAFE_ID=28310071` 추가해 실카페 전환
5. `install-poster-task.ps1`로 자동 시작 등록
6. `jinshopping.com/admin` 최상단 배너에서 **포스터 ONLINE** 표시 확인

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
