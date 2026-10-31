-- HandCricket Live - durable player accounts (Neon Postgres).
--
-- Paste this whole file into the Neon SQL Editor (or run it with psql) once,
-- against the same database DATABASE_URL points to. Idempotent: safe to re-run.
--
-- The backend connects directly with DATABASE_URL over TLS (sslmode=require)
-- as the database owner. Nothing here is exposed through a public API, and
-- passwords / session tokens only ever reach Postgres as hashes.
--
-- Tables 1-2 (app_users, app_user_sessions) are live: the backend reads and
-- writes them today. Tables 3-7 mirror the local friendships / stats /
-- achievements / DM / play-request store so every user-owned record has a
-- home in Neon, with the same status values and limits the app enforces.

begin;

-- ---------------------------------------------------------------------------
-- 1. Accounts
-- ---------------------------------------------------------------------------

create table if not exists public.app_users (
    id              text primary key,
    username        text not null,
    username_key    text not null,                  -- lowercase username, used for login
    display_name    text not null,
    password_hash   text not null,                  -- Werkzeug scrypt hash
    friend_code     text not null,                  -- e.g. 4F2K9A
    avatar          text not null default '🏏',
    bio             text not null default '',
    default_mode    text not null default 'SOLO'
                    check (default_mode in ('SOLO', 'TEAM')),
    default_overs   integer not null default 2
                    check (default_overs between 1 and 10),
    default_wickets integer not null default 1
                    check (default_wickets between 1 and 10),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    constraint app_users_username_key_unique unique (username_key),
    constraint app_users_friend_code_unique unique (friend_code)
);

-- ---------------------------------------------------------------------------
-- 2. Login sessions (only the SHA-256 of the bearer token is stored)
-- ---------------------------------------------------------------------------

create table if not exists public.app_user_sessions (
    id           text primary key,
    user_id      text not null
                 references public.app_users (id) on delete cascade,
    token_hash   text not null,
    user_agent   text not null default '',
    created_at   timestamptz not null default now(),
    last_used_at timestamptz not null default now(),
    expires_at   timestamptz not null,
    constraint app_user_sessions_token_hash_unique unique (token_hash)
);

-- ---------------------------------------------------------------------------
-- 3. Friendships (declined requests are deleted, so only these two statuses)
-- ---------------------------------------------------------------------------

create table if not exists public.app_friendships (
    id            text primary key,
    requester_id  text not null
                  references public.app_users (id) on delete cascade,
    addressee_id  text not null
                  references public.app_users (id) on delete cascade,
    status        text not null default 'PENDING'
                  check (status in ('PENDING', 'ACCEPTED')),
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    constraint app_friendships_pair_unique unique (requester_id, addressee_id),
    constraint app_friendships_not_self check (requester_id <> addressee_id)
);

-- ---------------------------------------------------------------------------
-- 4. Per-match stats (one durable row per player per finished match)
-- ---------------------------------------------------------------------------

create table if not exists public.app_user_match_stats (
    id             text primary key,
    user_id        text not null
                   references public.app_users (id) on delete cascade,
    match_id       text not null,
    room_id        text not null,
    mode           text not null check (mode in ('SOLO', 'TEAM')),
    team           text,
    result         text not null check (result in ('WIN', 'LOSS', 'TIE')),
    opponent_name  text not null default '',
    runs_scored    integer not null default 0 check (runs_scored >= 0),
    wickets_taken  integer not null default 0 check (wickets_taken >= 0),
    wickets_lost   integer not null default 0 check (wickets_lost >= 0),
    balls_faced    integer not null default 0 check (balls_faced >= 0),
    balls_bowled   integer not null default 0 check (balls_bowled >= 0),
    dead_balls     integer not null default 0 check (dead_balls >= 0),
    super_over     boolean not null default false,
    overs          integer not null default 0 check (overs >= 0),
    created_at     timestamptz not null default now(),
    constraint app_user_match_stats_once unique (user_id, match_id)
);

-- ---------------------------------------------------------------------------
-- 5. Earned achievement badges
-- ---------------------------------------------------------------------------

create table if not exists public.app_user_achievements (
    user_id   text not null
              references public.app_users (id) on delete cascade,
    code      text not null,
    earned_at timestamptz not null default now(),
    primary key (user_id, code)
);

-- ---------------------------------------------------------------------------
-- 6. Direct messages between players (1-200 characters, app-enforced)
-- ---------------------------------------------------------------------------

create table if not exists public.app_direct_messages (
    id           text primary key,
    sender_id    text not null
                 references public.app_users (id) on delete cascade,
    recipient_id text not null
                 references public.app_users (id) on delete cascade,
    body         text not null check (char_length(body) between 1 and 200),
    created_at   timestamptz not null default now(),
    read_at      timestamptz,
    constraint app_direct_messages_not_self check (sender_id <> recipient_id)
);

-- ---------------------------------------------------------------------------
-- 7. Match invites (play requests)
-- ---------------------------------------------------------------------------

create table if not exists public.app_play_requests (
    id           text primary key,
    requester_id text not null
                 references public.app_users (id) on delete cascade,
    recipient_id text not null
                 references public.app_users (id) on delete cascade,
    mode         text not null check (mode in ('SOLO', 'TEAM')),
    overs        integer not null check (overs between 1 and 10),
    wickets      integer not null check (wickets between 1 and 10),
    status       text not null default 'PENDING'
                 check (status in ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED')),
    room_id      text,
    room_code    text,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    constraint app_play_requests_not_self check (requester_id <> recipient_id),
    constraint app_play_requests_wickets_by_mode
        check ((mode = 'SOLO' and wickets between 1 and 5)
            or (mode = 'TEAM' and wickets between 1 and 10))
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

create index if not exists idx_app_users_username_key
    on public.app_users (username_key);
create index if not exists idx_app_users_friend_code
    on public.app_users (friend_code);
create index if not exists idx_app_user_sessions_user
    on public.app_user_sessions (user_id);
create index if not exists idx_app_user_sessions_expires
    on public.app_user_sessions (expires_at);

create index if not exists idx_app_friendships_requester
    on public.app_friendships (requester_id, status);
create index if not exists idx_app_friendships_addressee
    on public.app_friendships (addressee_id, status);

create index if not exists idx_app_user_match_stats_user
    on public.app_user_match_stats (user_id, created_at desc);
create index if not exists idx_app_user_match_stats_match
    on public.app_user_match_stats (match_id);

create index if not exists idx_app_dm_pair
    on public.app_direct_messages (sender_id, recipient_id, created_at desc);
create index if not exists idx_app_dm_recipient_unread
    on public.app_direct_messages (recipient_id, read_at);

create index if not exists idx_app_play_requests_recipient
    on public.app_play_requests (recipient_id, status);
create index if not exists idx_app_play_requests_requester
    on public.app_play_requests (requester_id, status);

commit;

-- Sanity check: should return 7.
select count(*) as account_tables
from information_schema.tables
where table_schema = 'public'
  and table_name in (
      'app_users',
      'app_user_sessions',
      'app_friendships',
      'app_user_match_stats',
      'app_user_achievements',
      'app_direct_messages',
      'app_play_requests'
  );
