-- ============================================================================
--  FRIDAY HUD · 소유자 전용 서버 보안(Supabase Auth + owner_id = auth.uid() RLS)
--  Supabase 대시보드 → SQL Editor 에 붙여넣고 RUN 한 번이면 적용됩니다.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- 1) HUD 소유자 계정 + 테스트용 2번째 계정 생성 (검증용 계정은 테스트 후 삭제 가능)
do $$
declare
  v_email    text := 'friday-hud@r1axodn.local';
  v_passcode text := '0409';
  v_uid      uuid;
  v_t_email  text := 'test-second-user@r1axodn.local';
  v_t_pass   text := 'TestPass1234!';
  v_t_uid    uuid;
begin
  -- 소유자 계정
  select id into v_uid from auth.users where email = v_email limit 1;
  if v_uid is null then
    v_uid := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, recovery_sent_at, last_sign_in_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token
    ) values (
      '00000000-0000-0000-0000-000000000000',
      v_uid, 'authenticated', 'authenticated', v_email,
      extensions.crypt(v_passcode, extensions.gen_salt('bf')),
      now(), null, null,
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"hud_owner":true}'::jsonb,
      now(), now(), '', '', '', ''
    );
  end if;
  if not exists (select 1 from auth.identities where user_id = v_uid and provider = 'email') then
    insert into auth.identities (
      id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), v_uid,
      jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true, 'phone_verified', false),
      'email', v_uid::text, now(), now(), now()
    );
  end if;

  -- 두 번째 로그인 테스트 계정 (다른 auth.uid() 검증용)
  select id into v_t_uid from auth.users where email = v_t_email limit 1;
  if v_t_uid is null then
    v_t_uid := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, recovery_sent_at, last_sign_in_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token
    ) values (
      '00000000-0000-0000-0000-000000000000',
      v_t_uid, 'authenticated', 'authenticated', v_t_email,
      extensions.crypt(v_t_pass, extensions.gen_salt('bf')),
      now(), null, null,
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"test_user":true}'::jsonb,
      now(), now(), '', '', '', ''
    );
  end if;
  if not exists (select 1 from auth.identities where user_id = v_t_uid and provider = 'email') then
    insert into auth.identities (
      id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), v_t_uid,
      jsonb_build_object('sub', v_t_uid::text, 'email', v_t_email, 'email_verified', true, 'phone_verified', false),
      'email', v_t_uid::text, now(), now(), now()
    );
  end if;
end $$;

-- 2) 소유자 UUID 조회 헬퍼
create or replace function public.hud_owner_id()
returns uuid
language sql
security definer
set search_path = public, auth, pg_temp
as $$
  select id from auth.users where email = 'friday-hud@r1axodn.local' limit 1;
$$;
revoke all on function public.hud_owner_id() from public, anon, authenticated;

-- 3) hud_panels: owner_id 추가 + owner_id = auth.uid() RLS
alter table public.hud_panels add column if not exists owner_id uuid;
update public.hud_panels set owner_id = public.hud_owner_id() where owner_id is null;
alter table public.hud_panels alter column owner_id set not null;
alter table public.hud_panels alter column owner_id set default public.hud_owner_id();

alter table public.hud_panels enable row level security;
drop policy if exists "hud_panels_public_read"        on public.hud_panels;
drop policy if exists "hud_panels_authenticated_read" on public.hud_panels;
drop policy if exists "hud_panels_owner_read"         on public.hud_panels;

revoke all on public.hud_panels from anon;
grant select on public.hud_panels to authenticated;

create policy "hud_panels_owner_read"
  on public.hud_panels for select
  to authenticated
  using (owner_id = auth.uid());

-- 4) hud_voice: owner_id 추가 + owner_id = auth.uid() RLS
alter table public.hud_voice add column if not exists owner_id uuid;
update public.hud_voice set owner_id = public.hud_owner_id() where owner_id is null;
alter table public.hud_voice alter column owner_id set not null;
alter table public.hud_voice alter column owner_id set default public.hud_owner_id();

alter table public.hud_voice enable row level security;
drop policy if exists "hud_voice_reply_public_read"  on public.hud_voice;
drop policy if exists "hud_voice_authenticated_read" on public.hud_voice;
drop policy if exists "hud_voice_owner_read"         on public.hud_voice;

revoke all on public.hud_voice from anon;
grant select on public.hud_voice to authenticated;

create policy "hud_voice_owner_read"
  on public.hud_voice for select
  to authenticated
  using (owner_id = auth.uid() and role = 'pickle');

-- 5) voice_say: 소유자(auth.uid() = hud_owner_id()) 또는 유효한 push_secret 만 허용
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
  if coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid) <> public.hud_owner_id()
     and public.hud_secret_ok(p_secret) is not true then
    raise exception 'owner authentication required' using errcode = '28000';
  end if;

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

  insert into public.hud_voice (owner_id, role, text, lang, device)
  values (public.hud_owner_id(), 'user', v_text,
          coalesce(nullif(btrim(coalesce(p_lang, '')), ''), 'ko-KR'),
          nullif(btrim(coalesce(p_device, '')), ''))
  returning id into v_id;

  delete from public.hud_voice where created_at < now() - interval '3 days';
  return v_id;
end;
$$;

revoke execute on function public.voice_say(text, text, text, text) from public;
grant  execute on function public.voice_say(text, text, text, text) to anon, authenticated;

-- 6) 검증 출력
select
  (select count(*) from public.hud_panels where owner_id = public.hud_owner_id()) as panels_owned,
  (select count(*) from public.hud_voice  where owner_id = public.hud_owner_id()) as voice_owned,
  exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'hud_panels') as rt_panels_ok,
  exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'hud_voice')  as rt_voice_ok;
