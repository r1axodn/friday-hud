create extension if not exists pgcrypto with schema extensions;
create table if not exists public.hud_voice (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  role       text not null default 'user' check (role in ('user', 'pickle')),
  text       text not null,
  lang       text not null default 'ko-KR',
  device     text,                       -- HUD 기기 식별자(브라우저가 만든 임의 문자열)
  replied_at timestamptz,                -- 사용자 발화에 FRIDAY 가 답한 시각
  meta       jsonb not null default '{}'::jsonb
);
create index if not exists hud_voice_created_at_idx
  on public.hud_voice (created_at desc);
create index if not exists hud_voice_role_created_idx
  on public.hud_voice (role, created_at desc);
alter table public.hud_voice enable row level security;
drop policy if exists "hud_voice_reply_public_read" on public.hud_voice;
create policy "hud_voice_reply_public_read"
  on public.hud_voice for select
  to anon, authenticated
  using (role = 'pickle');
grant select on public.hud_voice to anon, authenticated;
create or replace function public.voice_say(
  p_text   text,
  p_lang   text default 'ko-KR',
  p_device text default null,
  p_secret text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id   uuid;
  v_text text := btrim(coalesce(p_text, ''));
begin
  if v_text = '' then
    raise exception 'empty speech' using errcode = '22023';
  end if;
  if char_length(v_text) > 1000 then
    v_text := left(v_text, 1000);
  end if;
  if public.hud_secret_ok(p_secret) is not true then
    if (select count(*) from public.hud_voice
         where role = 'user'
           and created_at > now() - interval '60 seconds') >= 20 then
      raise exception 'too many voice items — 잠시 뒤 다시' using errcode = '54000';
    end if;
  end if;
  insert into public.hud_voice (role, text, lang, device)
  values ('user', v_text,
          coalesce(nullif(btrim(coalesce(p_lang, '')), ''), 'ko-KR'),
          nullif(btrim(coalesce(p_device, '')), ''))
  returning id into v_id;
  delete from public.hud_voice where created_at < now() - interval '3 days';
  return v_id;
end;
$$;
grant execute on function public.voice_say(text, text, text, text) to anon, authenticated;
create or replace function public.voice_reply(
  p_secret text,
  p_text   text,
  p_lang   text  default 'ko-KR',
  p_meta   jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id   uuid;
  v_text text := btrim(coalesce(p_text, ''));
begin
  if not public.hud_secret_ok(p_secret) then
    raise exception 'invalid push secret' using errcode = '28000';
  end if;
  if v_text = '' then
    raise exception 'empty reply' using errcode = '22023';
  end if;
  if char_length(v_text) > 4000 then
    v_text := left(v_text, 4000);
  end if;
  insert into public.hud_voice (role, text, lang, meta)
  values ('pickle', v_text,
          coalesce(nullif(btrim(coalesce(p_lang, '')), ''), 'ko-KR'),
          coalesce(p_meta, '{}'::jsonb))
  returning id into v_id;
  update public.hud_voice
     set replied_at = now()
   where role = 'user' and replied_at is null;
  delete from public.hud_voice where created_at < now() - interval '3 days';
  return v_id;
end;
$$;
grant execute on function public.voice_reply(text, text, text, jsonb) to anon, authenticated;
create or replace function public.voice_poll(
  p_secret       text,
  p_since        timestamptz default null,
  p_limit        integer     default 20,
  p_role         text        default 'user',
  p_only_pending boolean     default false
)
returns setof public.hud_voice
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := nullif(btrim(coalesce(p_role, '')), '');
begin
  if not public.hud_secret_ok(p_secret) then
    raise exception 'invalid push secret' using errcode = '28000';
  end if;
  if v_role = 'all' then
    v_role := null;
  end if;
  return query
    select v.*
      from public.hud_voice v
     where (v_role is null or v.role = v_role)
       and (p_since is null or v.created_at > p_since)
       and (coalesce(p_only_pending, false) is not true
            or v.role <> 'user'
            or v.replied_at is null)
     order by v.created_at asc
     limit greatest(1, least(coalesce(p_limit, 20), 200));
end;
$$;
grant execute on function public.voice_poll(text, timestamptz, integer, text, boolean) to anon, authenticated;
create or replace function public.voice_clear(
  p_secret text,
  p_role   text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role  text := nullif(btrim(coalesce(p_role, '')), '');
  v_count integer;
begin
  if not public.hud_secret_ok(p_secret) then
    raise exception 'invalid push secret' using errcode = '28000';
  end if;
  if v_role = 'all' then
    v_role := null;
  end if;
  if v_role is not null and v_role not in ('user', 'pickle') then
    raise exception 'unknown role: %', p_role using errcode = '22023';
  end if;
  delete from public.hud_voice where v_role is null or role = v_role;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
grant execute on function public.voice_clear(text, text) to anon, authenticated;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'hud_voice'
  ) then
    alter publication supabase_realtime add table public.hud_voice;
  end if;
end $$;
select
  exists (select 1 from information_schema.tables
           where table_schema = 'public' and table_name = 'hud_voice')   as voice_ok,
  exists (select 1 from pg_publication_tables
           where pubname = 'supabase_realtime'
             and schemaname = 'public' and tablename = 'hud_voice')      as voice_realtime_ok,
  (select count(*) from public.hud_config) > 0                           as secret_ok;
