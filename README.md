# FRIDAY HUD

아이언맨 FRIDAY 스타일의 실시간 HUD. 아이패드·아이폰에서 켜 두면
**시계 · D-DAY · 연결 상태**가 상시 떠 있고, Supabase Realtime 으로 새 패널이 들어오면
**0.2초 안에 카드가 팝업**됩니다.

- 화면: <https://r1axodn.github.io/friday-hud/> (GitHub Pages · `gh-pages` 브랜치)
- 데모: <https://r1axodn.github.io/friday-hud/?demo=1> (SQL 없이 연출만 확인)
- 저장소: <https://github.com/r1axodn/friday-hud>

---

## 1. 처음 한 번만: Supabase SQL

`cubetimer` 와 **같은 Supabase 프로젝트**(`vipaohlgodyrbjnsewuo`)를 그대로 씁니다.
새 프로젝트를 만들 필요 없이, SQL Editor 에서 한 번만 실행하면 끝입니다.

1. <https://supabase.com/dashboard/project/vipaohlgodyrbjnsewuo/sql/new> 열기
2. **피클이 따로 보내 준 SQL**(푸시 시크릿이 채워진 버전)을 통째로 붙여넣고 `RUN`
3. 마지막 결과가 `hud_panels_ok = true`, `realtime_ok = true` 면 성공

> 저장소의 [`supabase/hud.sql`](supabase/hud.sql) 은 시크릿 자리에
> `__PUSH_SECRET__` 이 들어 있는 **공개용 사본**입니다.
> 공개 저장소에 진짜 시크릿을 올리면 누구나 화면을 조작할 수 있어서, 실제 값은 채팅으로만 전달합니다.
> 직접 쓰고 싶다면 `__PUSH_SECRET__` 을 아무 긴 문자열(32자 이상)로 바꿔 실행해도 됩니다.

만들어지는 것

| 객체 | 역할 |
| --- | --- |
| `public.hud_panels` | 카드 한 장 = 1행. HUD 는 `SELECT` 만 (읽기 공개) |
| `public.hud_config` | 푸시 시크릿 1행. API 로는 읽을 수 없음 |
| `public.hud_push(...)` | 시크릿을 검사한 뒤 패널 1장 INSERT (RPC) |
| `public.hud_delete(...)` / `public.hud_clear(...)` | 패널 1장 / 전체 삭제 |
| `supabase_realtime` 발행 | `hud_panels` INSERT 를 HUD 로 실시간 전송 |

---

## 2. 화면

- **화면 정중앙 코어**: 실시간 시계(초 단위) · 날짜 · 다음 일정. 회전 링·초침 진행 링이 함께 돌아가고,
  창이 몇 개 떠 있어도 코어는 항상 화면 한가운데에 고정됩니다.
- **플로팅 홀로그램 창**: 뉴스·유튜브·이미지·브리핑 카드는 오른쪽 한 칸에 쌓이지 않고,
  화면 전체(좌·우·위·아래)에 반투명 창으로 떠 있습니다.
  - 한 개면 시계 옆 큰 창, 2개면 좌·우, 3개면 오른쪽 한 장 + 왼쪽 두 장,
    4개면 사분면, 5~6개면 두 열 3칸으로 **서로 겹치지 않게** 자동 배치
  - 창 제목줄을 마우스/터치로 끌어 화면 어디로든 옮길 수 있고, 누르면 그 창이 맨 위로 올라옵니다
  - 창 우하단 모서리를 끌면 크기를 자유롭게 키우고 줄일 수 있습니다 (최대 화면 스테이지 끝까지)
  - 제목줄 `⤢` 를 누르면 그 창만 화면 가득 커지고, `⤡` 로 원래 크기로 돌아옵니다
  - 한 창을 키우거나 옮겨도 다른 창은 줄어들거나 밀리지 않고 그대로 겹쳐 있습니다 (`TIDY` 를 누를 때만 다시 정렬)
  - 세로 아이패드는 시계 위·아래 띠에 2열, 폰은 시계를 가리지 않는 계단식 시트로 자동 전환
- **상태 타일(하단)**: 기말고사 D-DAY(2026-12-08) · 수능 D-DAY(2027-11-18) · 세션 업타임 · 수신 창 수 · 지연(초)
- **창 컨트롤**: `⤢ 크게/원래` `▣ 전체화면` `◈ 고정` `✕ 닫기`, 진행바(자동 사라짐), 하단 `RECENT FEED`에서 다시 띄우기
- **상단**: `ONLINE · REALTIME` 연결 표시, `TIDY`(창 다시 펼치기), `DEMO POPUP`, `SFX`, `FULL`, `LOCK`
- **긴급 알림(`alert`)**: 화면 상단 전체폭 배너 — 배너가 떠 있는 동안 창은 그 아래로 내려갑니다

키보드: `D` 데모 · `F` 전체화면 · `ESC` 맨 위 창 닫기

카드 타입 5가지

| type | 쓰는 필드 |
| --- | --- |
| `news` | `title` `body`(요약) `url`(원문) `source` |
| `youtube` | `url` (유튜브 주소 또는 11자리 videoId) `title` `body` |
| `image` | `image_url` `caption` `title` |
| `briefing` | `title` `body` (간단 마크다운: `- 목록`, `**굵게**`, `### 소제목`, `[링크](url)`) |
| `alert` | `title` `body` — 화면 상단 전체폭 긴급 배너로 뜸 |

`duration`(초, 기본 25 · `0` 이면 직접 닫을 때까지) · `pinned`(true 면 자동으로 안 사라짐) · `priority`(정렬용)

---

## 3. 패널 띄우는 방법 (REST)

```bash
BASE=https://vipaohlgodyrbjnsewuo.supabase.co
KEY=sb_publishable_pl28DHu3fwfqU-Nw92hyPg_nLcdeJaS

curl -s -X POST "$BASE/rest/v1/rpc/hud_push" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"p_secret":"<PUSH_SECRET>","p_type":"news","p_title":"제목","p_body":"요약","p_url":"https://...","p_source":"연합뉴스"}'
```

응답은 새 패널의 `id`(uuid). 실패하면 `invalid push secret` 오류가 돌아옵니다.

```bash
# 유튜브
-d '{"p_secret":"<S>","p_type":"youtube","p_title":"영상","p_url":"https://youtu.be/aqz-KE-bpKQ"}'

# 이미지
-d '{"p_secret":"<S>","p_type":"image","p_image_url":"https://.../a.jpg","p_caption":"캡션"}'

# 브리핑 (여러 줄은 \n)
-d '{"p_secret":"<S>","p_type":"briefing","p_title":"오늘의 브리핑","p_body":"- 09:00 기상\n- 13:00 학원","p_duration":0,"p_pinned":true}'

# 긴급 배너
-d '{"p_secret":"<S>","p_type":"alert","p_title":"긴급","p_body":"내용","p_duration":20}'

# 정리
-d '{"p_secret":"<S>"}'        # POST /rest/v1/rpc/hud_clear
-d '{"p_secret":"<S>","p_id":"<uuid>"}'   # POST /rest/v1/rpc/hud_delete
```

---

## 4. 보안

- anon(publishable) 키는 공개되어도 됩니다. `hud_panels` 는 **읽기만** 허용되고
  INSERT/UPDATE/DELETE 정책이 없어서 직접 쓰기가 막힙니다.
- 쓰기는 `hud_push` / `hud_delete` / `hud_clear` RPC 뿐이고, 셋 다 `hud_config` 의
  시크릿과 일치해야 실행됩니다. 시크릿은 API 로 조회할 수 없습니다.
- 공개 저장소에는 진짜 시크릿을 올리지 않습니다(SQL 파일은 placeholder 사본).

---

## 5. 아이패드에서 켜 두기

1. Safari 로 접속 → **공유 → 홈 화면에 추가** → 홈 화면 아이콘으로 실행(주소창 없는 전체화면)
2. **설정 → 디스플레이 및 밝기 → 자동 잠금 → 안 함**
3. **저전력 모드 끄기**(켜면 백그라운드 연결이 끊깁니다)
4. 화면을 오래 켜 두면 번인 방지를 위해 밝기를 60% 정도로

---

## 6. 배포 구조

이 저장소는 **main(작업) → gh-pages(배포)** 두 브랜치를 씁니다.
GitHub Pages 가 `gh-pages` 브랜치 루트를 바라보고 있어서,
main 을 고친 뒤 아래 한 줄만 실행하면 사이트가 갱신됩니다.

```bash
git push origin main                # 작업 기록
git push origin main:gh-pages       # 배포
```

- 파일을 고치면 `index.html` 의 `style.css?v=` / `app.js?v=` 숫자를 올려 주세요(캐시).
- 배포 후 반영까지 30~60초 걸립니다.

## 7. 안 되는 것 같을 때

| 증상 | 확인 |
| --- | --- |
| 카드가 안 뜸 | Supabase SQL 을 실행했는지, 상단 필이 `ONLINE · REALTIME` 인지 |
| `DB SETUP NEEDED` | SQL 미실행. SQL Editor 에서 실행 |
| `RECONNECTING` | 잠시 후 자동 재연결. 8초 폴링으로도 카드는 뜸 |
| 화면 연출만 보고 싶다 | `?demo=1` 붙이거나 `DEMO POPUP` 버튼 |
| 유튜브 카드가 검게 나옴 | 영상 소유자가 임베드를 막은 경우. `YouTube ↗` 링크로 열기 |

## 파일

```
index.html        HUD 마크업
style.css         다크 네온 스타일 · 가로/세로 반응형
app.js            시계 · D-DAY · Realtime 구독 · 카드/배너 렌더 · 데모
manifest.webmanifest, sw.js, icon-*.png, apple-touch-icon.png, icon.svg   PWA
supabase/hud.sql  DB 설정 SQL (공개용 placeholder 사본)
```
