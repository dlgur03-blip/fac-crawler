# fac-crawler — Claude Code 지침

- 이 레포는 **네이버 카페 크롤러 데몬 전용 배포 레포**다. 쇼핑몰 본체는 `fac` 레포.
- **코드의 원본은 fac 레포**: `src/lib/naver/*`와 `scripts/naver-crawler-daemon.ts`를 여기서 직접 수정하지 마라 — fac에서 수정 후 `scripts/sync-crawler-repo.sh`로 동기화된다. 여기서 고치면 다음 동기화 때 덮어써진다. (윈도우 전용 스크립트 `scripts/windows/*`와 README는 이 레포에서 수정 가능)
- 설치/운영 절차는 `README.md`가 단일 기준이다. 설치 요청을 받으면 README 순서대로 실행하라.
- `.env.local`, `.naver_profile/`, `*.log`는 절대 커밋 금지 (.gitignore에 있음).
- 데몬 실행 전 같은 머신에서 이미 돌고 있는지 확인하라 (작업 스케줄러 "FACTORIES-CrawlerDaemon" 또는 node 프로세스). 이중 실행 금지.
