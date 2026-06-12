# Supabase Room Sync Migration

작성일: 2026-06-12  
대상 프로젝트: `AIBE7-Project1-E1I3`

## 요약

여행방 단위 동기화를 하려면 `schedule`과 `finance` 데이터는 `room_id`를 가져야 합니다.  
다만 이미지 업로드는 Supabase Storage 객체 자체에 SQL 컬럼을 붙일 수 없으므로, `room_id`를 저장하는 별도 메타 테이블 `album_images`를 두는 방식이 올바른 방향입니다.

즉:

- `schedules`: `room_id` 추가
- `schedules`: 지도 연동용 `place_name`, `place_x`, `place_y` 추가
- `expenses`: `room_id` 추가
- `budgets`: `room_id` 추가
- `album_images`: 새로 생성

## 왜 이 마이그레이션이 필요한가

현재 프론트 코드는 여행방 화면에서 `roomId`를 기준으로 일정, 지출, 예산, 앨범을 같은 방 사람끼리 공유하도록 동작합니다.

하지만 DB가 예전 스키마라면 아래 문제가 생깁니다.

- `POST /rest/v1/schedules` 시 `room_id` 컬럼이 없어서 `400 Bad Request`
- `POST /rest/v1/expenses` 또는 `POST /rest/v1/budgets` 시 `room_id` 컬럼이 없어서 `400 Bad Request`
- 이미지의 경우 Storage에는 `room_id` 컬럼을 둘 수 없어서, 방 기준 공유/삭제 제어를 안정적으로 하기 어려움

## 적용 전 확인

아래 SQL은 `rooms`, `members` 테이블이 이미 존재한다고 가정합니다.

- `rooms.id`는 `uuid`
- `members.room_id`는 `rooms.id`를 참조
- `members.user_id`는 `auth.users.id`를 참조

프로젝트의 현재 구조상 이 가정은 자연스럽습니다.

## 권장 마이그레이션 SQL

Supabase SQL Editor에서 아래를 순서대로 실행하세요.

```sql
begin;

-- 1) schedules 확장
alter table public.schedules
  add column if not exists room_id uuid references public.rooms(id) on delete cascade,
  add column if not exists place_name text,
  add column if not exists place_x double precision,
  add column if not exists place_y double precision;

create index if not exists schedules_room_id_idx
  on public.schedules(room_id);


-- 2) expenses 확장
alter table public.expenses
  add column if not exists room_id uuid references public.rooms(id) on delete cascade;

create index if not exists expenses_room_id_idx
  on public.expenses(room_id);


-- 3) budgets 확장
alter table public.budgets
  add column if not exists room_id uuid references public.rooms(id) on delete cascade;

create index if not exists budgets_room_id_idx
  on public.budgets(room_id, created_at desc);


-- 4) 여행 앨범 메타 테이블 생성
create table if not exists public.album_images (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references public.rooms(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  storage_path  text not null unique,
  original_name text,
  created_at    timestamptz not null default now()
);

create index if not exists album_images_room_id_idx
  on public.album_images(room_id, created_at desc);

create index if not exists album_images_user_id_idx
  on public.album_images(user_id);

commit;
```

## RLS 권장 SQL

`room_id`가 생기면, 같은 여행방 멤버끼리 조회 가능하고 작성자만 수정/삭제 가능하도록 정책을 맞추는 편이 좋습니다.

주의:

- 이미 동일 이름의 정책이 있으면 먼저 삭제하거나 이름을 바꿔서 적용하세요.
- 아래는 "권장 예시"입니다.

```sql
-- schedules
alter table public.schedules enable row level security;

drop policy if exists schedules_select_all on public.schedules;
drop policy if exists schedules_insert_auth on public.schedules;
drop policy if exists schedules_update_own on public.schedules;
drop policy if exists schedules_delete_own on public.schedules;

create policy schedules_select_room_members
  on public.schedules
  for select
  using (
    room_id is null
    or exists (
      select 1
      from public.members m
      where m.room_id = schedules.room_id
        and m.user_id = auth.uid()
    )
  );

create policy schedules_insert_room_members
  on public.schedules
  for insert
  with check (
    auth.uid() = user_id
    and (
      room_id is null
      or exists (
        select 1
        from public.members m
        where m.room_id = schedules.room_id
          and m.user_id = auth.uid()
      )
    )
  );

create policy schedules_update_own
  on public.schedules
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy schedules_delete_own
  on public.schedules
  for delete
  using (auth.uid() = user_id);


-- expenses
alter table public.expenses enable row level security;

drop policy if exists expenses_select_all on public.expenses;
drop policy if exists expenses_insert_own on public.expenses;
drop policy if exists expenses_update_own on public.expenses;
drop policy if exists expenses_delete_own on public.expenses;

create policy expenses_select_room_members
  on public.expenses
  for select
  using (
    room_id is null
    or exists (
      select 1
      from public.members m
      where m.room_id = expenses.room_id
        and m.user_id = auth.uid()
    )
  );

create policy expenses_insert_room_members
  on public.expenses
  for insert
  with check (
    auth.uid() = user_id
    and (
      room_id is null
      or exists (
        select 1
        from public.members m
        where m.room_id = expenses.room_id
          and m.user_id = auth.uid()
      )
    )
  );

create policy expenses_update_own
  on public.expenses
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy expenses_delete_own
  on public.expenses
  for delete
  using (auth.uid() = user_id);


-- budgets
alter table public.budgets enable row level security;

drop policy if exists budgets_select_all on public.budgets;
drop policy if exists budgets_insert_own on public.budgets;

create policy budgets_select_room_members
  on public.budgets
  for select
  using (
    room_id is null
    or exists (
      select 1
      from public.members m
      where m.room_id = budgets.room_id
        and m.user_id = auth.uid()
    )
  );

create policy budgets_insert_room_members
  on public.budgets
  for insert
  with check (
    auth.uid() = user_id
    and (
      room_id is null
      or exists (
        select 1
        from public.members m
        where m.room_id = budgets.room_id
          and m.user_id = auth.uid()
      )
    )
  );


-- album_images
alter table public.album_images enable row level security;

drop policy if exists album_images_select_room_members on public.album_images;
drop policy if exists album_images_insert_room_members on public.album_images;
drop policy if exists album_images_delete_own on public.album_images;

create policy album_images_select_room_members
  on public.album_images
  for select
  using (
    exists (
      select 1
      from public.members m
      where m.room_id = album_images.room_id
        and m.user_id = auth.uid()
    )
  );

create policy album_images_insert_room_members
  on public.album_images
  for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.members m
      where m.room_id = album_images.room_id
        and m.user_id = auth.uid()
    )
  );

create policy album_images_delete_own
  on public.album_images
  for delete
  using (auth.uid() = user_id);
```

## Storage 정책 권장 방향

이미지는 SQL 테이블이 아니라 Storage 버킷에 저장되므로, `album_images`만 만들어서는 끝나지 않습니다.

권장 방향:

- 버킷 이름: `image`
- 업로드 경로: `{room_id}/{user_id}__{uuid}.{ext}`
- 읽기: 로그인 사용자 허용 또는 signed URL 기반 허용
- 삭제: 업로더 본인만 허용

현재 프론트는 signed URL을 생성해서 보여주므로, 버킷을 public으로 열 필요는 없습니다.

## 현재 코드 기준 반영 사항

이번 수정으로 코드도 같이 정리되었습니다.

- `schedule.js`
  - `roomId`가 UUID일 때만 `room_id` 전송
  - 구형 스키마면 최소 컬럼으로 재시도

- `finance.js`
  - `roomId`가 UUID일 때만 `room_id` 전송
  - `expenses`, `budgets` 모두 구형 스키마 fallback 포함

- `imageupload.js`
  - 올바른 방향으로 `album_images` 메타 테이블을 우선 사용
  - 아직 테이블이 없으면 기존 Storage 폴더 listing으로 fallback

## 잘못 이해하기 쉬운 포인트

### 1. "이미지에도 room_id 컬럼을 추가하면 된다"

이건 절반만 맞습니다.

이미지 "파일" 자체는 Storage 객체라서, `alter table`로 컬럼을 추가하는 대상이 아닙니다.  
따라서 올바른 해법은 `album_images` 같은 메타 테이블을 별도로 두고, 그 테이블에 `room_id`를 저장하는 것입니다.

### 2. "global을 room_id에 넣으면 되지 않나"

아닙니다.

대부분 `room_id`는 `uuid` FK로 설계하는 것이 맞아서, `"global"` 문자열을 넣으면 바로 `400 Bad Request`가 날 수 있습니다.

그래서 코드도 `roomId`가 진짜 UUID일 때만 `room_id`를 보내도록 수정하는 것이 안전합니다.

## 적용 순서 권장

1. 이 문서의 `권장 마이그레이션 SQL` 실행
2. 필요 시 `RLS 권장 SQL` 적용
3. 브라우저에서 여행방 페이지 기준으로 테스트
4. 테스트 항목
   - 일정 추가
   - 지출 추가
   - 예산 저장
   - 이미지 업로드
   - 다른 계정으로 같은 방 접속 후 공유 여부 확인

## 테스트 체크리스트

- 같은 `roomId`의 두 계정에서 일정이 같이 보인다
- 같은 `roomId`의 두 계정에서 지출/예산이 같이 보인다
- 같은 `roomId`의 두 계정에서 이미지가 같이 보인다
- 타인 이미지에는 삭제 버튼이 보이지 않는다
- 타인 일정/지출의 작성자 제약이 의도대로 동작한다
