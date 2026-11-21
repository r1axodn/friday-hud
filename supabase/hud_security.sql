-- ============================================================================
--  FRIDAY HUD · 소유자 전용 서버 보안 v2 (긴 비밀번호 + hud_settings + Realtime 봉인)
--  Supabase 대시보드 → SQL Editor 에 붙여넣고 RUN 한 번이면 적용됩니다.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- 1) HUD 소유자 계정 비밀번호를 긴 비밀번호로 갱신 + 테스트 2번째 계정 유지
do $$
declare
  v_email    text := 'friday-hud@r1axodn.local';
  v_passcode text := '$seouluni28!';
  v_uid      uuid;
  v_t_email  text := 'test-second-user@r1axodn.local';
  v_t_pass   text := 'TestPass1234!';
  v_t_uid    uuid;
begin
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
      now(), null, null, '{"provider":"email","providers":["email"]}'::jsonb,
      '{"hud_owner":true}'::jsonb, now(), now(), '', '', '', ''
    );
  else
    update auth.users
       set encrypted_password = extensions.crypt(v_passcode, extensions.gen_salt('bf')),
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           updated_at = now()
     where id = v_uid;
  end if;
  if not exists (select 1 from auth.identities where user_id = v_uid and provider = 'email') then
    insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_uid, jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true, 'phone_verified', false), 'email', v_uid::text, now(), now(), now());
  end if;

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
      now(), null, null, '{"provider":"email","providers":["email"]}'::jsonb,
      '{"test_user":true}'::jsonb, now(), now(), '', '', '', ''
    );
  end if;
  if not exists (select 1 from auth.identities where user_id = v_t_uid and provider = 'email') then
    insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_t_uid, jsonb_build_object('sub', v_t_uid::text, 'email', v_t_email, 'email_verified', true, 'phone_verified', false), 'email', v_t_uid::text, now(), now(), now());
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

-- 3) 개인 설정(D-DAY 등) 비공개 테이블 — 코드에 싣지 않고 인증 후 DB에서만 읽음
create table if not exists public.hud_settings (
  owner_id     uuid primary key default public.hud_owner_id(),
  dday_1_label text not null,
  dday_1_date  text not null,
  dday_1_sub   text not null default '',
  dday_2_label text not null,
  dday_2_date  text not null,
  dday_2_sub   text not null default '',
  updated_at   timestamptz not null default now()
);

insert into public.hud_settings (owner_id, dday_1_label, dday_1_date, dday_1_sub, dday_2_label, dday_2_date, dday_2_sub)
values (public.hud_owner_id(), '기말고사', '2026-12-08', '2026.12.08 08:30', '수능', '2027-11-18', '2027.11.18')
on conflict (owner_id) do update
  set dday_1_label = excluded.dday_1_label,
      dday_1_date  = excluded.dday_1_date,
      dday_1_sub   = excluded.dday_1_sub,
      dday_2_label = excluded.dday_2_label,
      dday_2_date  = excluded.dday_2_date,
      dday_2_sub   = excluded.dday_2_sub,
      updated_at   = now();

alter table public.hud_settings enable row level security;
drop policy if exists "hud_settings_owner_read" on public.hud_settings;
revoke all on public.hud_settings from anon;
grant select on public.hud_settings to authenticated;
create policy "hud_settings_owner_read"
  on public.hud_settings for select
  to authenticated
  using (owner_id = auth.uid());

-- 4) Realtime Private Channel 봉인 (realtime.messages RLS → 소유자만 채널 참가)
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'alter table realtime.messages enable row level security';
    execute 'drop policy if exists "hud_rt_owner_read" on realtime.messages';
    execute 'create policy "hud_rt_owner_read" on realtime.messages for select to authenticated using (auth.uid() = public.hud_owner_id())';
    execute 'drop policy if exists "hud_rt_owner_write" on realtime.messages';
    execute 'create policy "hud_rt_owner_write" on realtime.messages for insert to authenticated with check (auth.uid() = public.hud_owner_id())';
  end if;
end $$;

-- 5) 검증 출력
select
  exists (select 1 from public.hud_settings where owner_id = public.hud_owner_id()) as settings_ok,
  not has_table_privilege('anon', 'public.hud_settings', 'SELECT') as anon_settings_blocked,
  to_regclass('realtime.messages') is not null as rt_messages_present;
