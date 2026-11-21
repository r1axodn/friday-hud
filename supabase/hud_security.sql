-- ============================================================================
--  FRIDAY HUD · 실제 서버 보안(Supabase Auth + RLS) 마이그레이션 SQL
--  Supabase 대시보드 → SQL Editor 에 붙여넣고 RUN 한 번이면 적용됩니다.
--
--  적용 내용:
--   1) HUD 전용 Auth 계정 생성/갱신 (이메일: friday-hud@r1axodn.local)
--      · 아래 '__PASSCODE__' 기본값은 '0409'이며 원하면 원하는 숫자로 바꾸세요.
--   2) hud_panels RLS 강화: anon 읽기 완전 차단 → authenticated 만 SELECT 가능
--   3) hud_voice RLS 강화: anon 읽기 완전 차단 → authenticated 만 SELECT 가능
--   4) voice_say RPC 강화: authenticated 세션 또는 hud_secret 이 있어야만 호출 가능
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- 1) HUD 전용 Supabase Auth 유저 생성 (서버 측 bcrypt 해시 검증)
-- ---------------------------------------------------------------------------
do $$
declare
  v_email    text := 'friday-hud@r1axodn.local';
  v_passcode text := '0409';
  v_uid      uuid;
begin
  select id into v_uid from auth.users where email = v_email limit 1;

  if v_uid is null then
    v_uid := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, recovery_sent_at, last_sign_in_at,
      raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token
    ) values (
      '00000000-0000-0000-0000-000000000000',
      v_uid, 'authenticated', 'authenticated', v_email,
      extensions.crypt(v_passcode, extensions.gen_salt('bf')),
      now(), null, null,
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"hud_owner":true}'::jsonb,
      now(), now(),
      '', '', '', ''
    );
  else
    update auth.users
       set encrypted_password = extensions.crypt(v_passcode, extensions.gen_salt('bf')),
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           updated_at         = now()
     where id = v_uid;
  end if;

  if not exists (
    select 1 from auth.identities
     where user_id = v_uid and provider = 'email'
  ) then
    insert into auth.identities (
      id, user_id, identity_data, provider, provider_id,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(),
      v_uid,
      jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true, 'phone_verified', false),
      'email',
      v_uid::text,
      now(), now(), now()
    );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2) hud_panels RLS — 익명(anon) 완전 차단, authenticated 만 SELECT 허용
-- ---------------------------------------------------------------------------
alter table public.hud_panels enable row level security;

drop policy if exists "hud_panels_public_read"        on public.hud_panels;
drop policy if exists "hud_panels_authenticated_read" on public.hud_panels;

revoke all on public.hud_panels from anon;
grant select on public.hud_panels to authenticated;

create policy "hud_panels_authenticated_read"
  on public.hud_panels for select
  to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- 3) hud_voice RLS — 익명(anon) 완전 차단, authenticated 만 SELECT 허용
-- ---------------------------------------------------------------------------
alter table public.hud_voice enable row level security;

drop policy if exists "hud_voice_reply_public_read"  on public.hud_voice;
drop policy if exists "hud_voice_authenticated_read" on public.hud_voice;

revoke all on public.hud_voice from anon;
grant select on public.hud_voice to authenticated;

create policy "hud_voice_authenticated_read"
  on public.hud_voice for select
  to authenticated
  using (role = 'pickle');

-- ---------------------------------------------------------------------------
-- 4) voice_say — 인증된 세션 또는 유효한 push_secret 으로만 호출 가능
-- ---------------------------------------------------------------------------
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
  if coalesce(auth.role(), '') <> 'authenticated' and public.hud_secret_ok(p_secret) is not true then
    raise exception 'authentication required' using errcode = '28000';
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

  insert into public.hud_voice (role, text, lang, device)
  values ('user', v_text,
          coalesce(nullif(btrim(coalesce(p_lang, '')), ''), 'ko-KR'),
          nullif(btrim(coalesce(p_device, '')), ''))
  returning id into v_id;

  delete from public.hud_voice where created_at < now() - interval '3 days';
  return v_id;
end;
$$;

revoke execute on function public.voice_say(text, text, text, text) from public;
grant  execute on function public.voice_say(text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5) 검증 출력
-- ---------------------------------------------------------------------------
select
  exists (select 1 from auth.users where email = 'friday-hud@r1axodn.local') as auth_user_ok,
  not has_table_privilege('anon', 'public.hud_panels', 'SELECT')            as anon_panels_blocked,
  not has_table_privilege('anon', 'public.hud_voice',  'SELECT')            as anon_voice_blocked,
  has_table_privilege('authenticated', 'public.hud_panels', 'SELECT')       as auth_panels_ok,
  has_table_privilege('authenticated', 'public.hud_voice',  'SELECT')       as auth_voice_ok;
