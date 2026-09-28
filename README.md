# Nova Player

광고·추적 코드 없는 오픈소스 미디어 플레이어 (Windows, Electron 기반).

KMPlayer급 편의 기능을 목표로 한다: 다양한 코덱 지원, 풍부한 단축키,
자막(SRT/VTT/ASS·SSA/MicroDVD, EUC-KR 자동 감지), 10밴드 이퀄라이저와
음향 DSP, 영상 필터, A-B 반복, 프레임 단위 이동, 스냅샷, 재생목록,
이어보기, 취침 타이머.

## 개인정보 원칙

- 인앱 광고·서드파티 스크립트 없음
- 재생 중 외부 네트워크 통신 전면 차단 (`http/https/ws` 요청 차단 + CSP)
- 사용 통계·크래시 리포트 수집 없음 (관련 코드 자체가 없음)
- 재생 이력·설정은 로컬 JSON(`%APPDATA%/Nova Player`)에만 저장
- 관리자 권한 요구 없음

## 실행

```powershell
cd novaplayer
npm install
npm start        # 실행
npm run dev      # 개발자 도구와 함께 실행
```

## 테스트

```powershell
node assets\logic-test.js   # 렌더러 로직 단위 테스트 (자막 파서, 유틸)
node assets\smoke-test.js   # main 프로세스·ffmpeg·인코딩 스모크 테스트
node assets\gui-test.js     # Electron 실제 구동 GUI 테스트
node assets\make-test-media.js  # 테스트용 샘플 미디어 생성
```

## 패키징

```powershell
npm run dist     # NSIS 설치본 + 포터블 EXE (build/icon.ico 사용)
```

ffmpeg/ffprobe는 `ffmpeg-static`·`ffprobe-static`으로 번들되며,
재생 실패 시 재 mux → 실시간 트랜스코딩 순으로 자동 복구를 시도한다.

## 단축키

앱 내 **도구 → 단축키 목록** 또는 **설정 → 단축키**에서 전체 목록을
확인·변경할 수 있다. 대표 단축키:

| 동작 | 키 |
|---|---|
| 재생/일시정지 | Space |
| 5초/30초/1분 탐색 | ←/→, Shift+←/→, Ctrl+←/→ |
| 볼륨/음소거 | ↑/↓, M |
| 전체화면 | F / Enter |
| 현재 장면 저장 | S |
| A-B 반복 | Ctrl+Alt+L |
| 자막 켜기/끄기 | B |
| 재생목록 | Ctrl+L |
| 설정 | Ctrl+P |

## 라이선스

MIT. Chromium·ffmpeg의 각 라이선스를 따른다.
