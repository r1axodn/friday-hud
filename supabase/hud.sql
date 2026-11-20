-- ============================================================================
--  FRIDAY HUD · Supabase 설정 SQL
--  Supabase 대시보드 → SQL Editor 에 그대로 붙여넣고 RUN 한 번이면 끝납니다.
--  (여러 번 실행해도 안전합니다 — 테이블/정책/발행/시크릿을 모두 덮어쓰기 방식)
--
--  프로젝트: vipaohlgodyrbjnsewuo (cubetimer 와 같은 프로젝트)
--  만드는 것: hud_panels(패널 테이블) + hud_config(푸시 시크릿) + RPC 3개
--             + RLS(읽기만 공개 / 쓰기는 시크릿을 아는 쪽만) + Realtime 발행
-- ============================================================================

-- 0) 확장 (gen_random_uuid)
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- 1) 푸시 시크릿 보관 테이블 — 단일 행. API로는 절대 읽을 수 없습니다.
-- ---------------------------------------------------------------------------
create table if not exists public.hud_config (
  id          boolean primary key default true check (id),
  push_secret text    not null,
  updated_at  timestamptz not null default now()
);

alter table public.hud_config enable row level security;
revoke all on public.hud_config from anon, authenticated;

insert into public.hud_config (id, push_secret, updated_at)
values (true, '__PUSH_SECRET__', now())
on conflict (id) do update
  set push_secret = excluded.push_secret,
      updated_at  = excluded.updated_at;

-- 공개용 사본을 시크릿 없이 그대로 실행하면 여기서 멈춥니다.
do $$
begin
  if not exists (
    select 1 from public.hud_config
     where id and push_secret ~ '^[a-f0-9]{32,}$'
  ) then
    raise exception 'push_secret 이 비어 있습니다 — SQL 상단의 시크릿 값을 실제 값(32자 이상)으로 바꾼 뒤 다시 실행하세요';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2) 패널 테이블 — HUD에 띄울 카드 한 장 = 1행
-- ---------------------------------------------------------------------------
create table if not exists public.hud_panels (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  type       text not null default 'news'
             check (type in ('news', 'youtube', 'image', 'briefing', 'alert')),
  title      text,
  body       text,        -- news 요약 / briefing 본문(간단 마크다운)
  url        text,        -- 출처 링크, youtube 주소
  image_url  text,        -- image 카드 이미지 주소
  caption    text,        -- image 캡션
  source     text,        -- 출처 이름 (예: 연합뉴스)
  priority   integer not null default 0,
  duration   integer not null default 25,   -- 자동 사라짐(초). 0 = 직접 닫을 때까지
  pinned     boolean not null default false,
  meta       jsonb   not null default '{}'::jsonb
);

create index if not exists hud_panels_created_at_idx
  on public.hud_panels (created_at desc);

-- ---------------------------------------------------------------------------
-- 3) RLS — 읽기는 누구나(HUD 화면), 쓰기는 아래 RPC(시크릿 검사)로만
--    insert/update/delete 정책을 만들지 않으므로 anon 키로는 직접 쓸 수 없습니다.
-- ---------------------------------------------------------------------------
alter table public.hud_panels enable row level security;

drop policy if exists "hud_panels_public_read" on public.hud_panels;
create policy "hud_panels_public_read"
  on public.hud_panels for select
  to anon, authenticated
  using (true);

grant select on public.hud_panels to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) 시크릿 검사 헬퍼 (내부 전용 — anon 은 호출 권한 없음)
-- ---------------------------------------------------------------------------
create or replace function public.hud_secret_ok(p_secret text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.hud_config
     where id
       and p_secret is not null
       and length(p_secret) >= 16
       and push_secret = p_secret
  );
$$;

revoke all on function public.hud_secret_ok(text) from public;
revoke all on function public.hud_secret_ok(text) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5) RPC: hud_push — 패널 한 장 밀어넣기
--    POST /rest/v1/rpc/hud_push
-- ---------------------------------------------------------------------------
create or replace function public.hud_push(
  p_secret    text,
  p_type      text,
  p_title     text    default null,
  p_body      text    default null,
  p_url       text    default null,
  p_image_url text    default null,
  p_caption   text    default null,
  p_source    text    default null,
  p_priority  integer default 0,
  p_duration  integer default 25,
  p_pinned    boolean default false,
  p_meta      jsonb   default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id   uuid;
  v_type text := lower(coalesce(p_type, ''));
begin
  if not public.hud_secret_ok(p_secret) then
    raise exception 'invalid push secret' using errcode = '28000';
  end if;

  if v_type not in ('news', 'youtube', 'image', 'briefing', 'alert') then
    raise exception 'unknown panel type: %', p_type using errcode = '22023';
  end if;

  insert into public.hud_panels
    (type, title, body, url, image_url, caption, source, priority, duration, pinned, meta)
  values
    (v_type,
     nullif(p_title, ''), nullif(p_body, ''), nullif(p_url, ''),
     nullif(p_image_url, ''), nullif(p_caption, ''), nullif(p_source, ''),
     coalesce(p_priority, 0), coalesce(p_duration, 25), coalesce(p_pinned, false),
     coalesce(p_meta, '{}'::jsonb))
  returning id into v_id;

  -- 오래된 패널은 7일 뒤 자동 정리
  delete from public.hud_panels where created_at < now() - interval '7 days';

  return v_id;
end;
$$;

grant execute on function public.hud_push(text, text, text, text, text, text, text, text, integer, integer, boolean, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6) RPC: hud_delete — 패널 한 장 지우기 / hud_clear — 전부 지우기
-- ---------------------------------------------------------------------------
create or replace function public.hud_delete(p_secret text, p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.hud_secret_ok(p_secret) then
    raise exception 'invalid push secret' using errcode = '28000';
  end if;
  delete from public.hud_panels where id = p_id;
  return found;
end;
$$;

grant execute on function public.hud_delete(text, uuid) to anon, authenticated;

create or replace function public.hud_clear(p_secret text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if not public.hud_secret_ok(p_secret) then
    raise exception 'invalid push secret' using errcode = '28000';
  end if;
  delete from public.hud_panels;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.hud_clear(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7) Realtime 발행 등록 (이미 등록돼 있으면 건너뜀)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'hud_panels'
  ) then
    alter publication supabase_realtime add table public.hud_panels;
  end if;
exception
  when undefined_object then
    create publication supabase_realtime for table public.hud_panels;
end $$;

-- ---------------------------------------------------------------------------
-- 8) 확인용 출력 (성공하면 setup_ok = true)
-- ---------------------------------------------------------------------------
select
  exists (select 1 from information_schema.tables
           where table_schema = 'public' and table_name = 'hud_panels') as hud_panels_ok,
  exists (select 1 from pg_publication_tables
           where pubname = 'supabase_realtime'
             and schemaname = 'public' and tablename = 'hud_panels')       as realtime_ok,
  (select count(*) from public.hud_config) > 0                             as secret_ok;
