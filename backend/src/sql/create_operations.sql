create table if not exists operations (
  id serial primary key,
  workset_id integer not null references worksets(id) on delete cascade,
  operation_type text not null check (operation_type in ('LOAD','DISCHARGE')),
  bay integer not null,
  area text not null check (area in ('DECK','HOLD')),
  created_at timestamptz not null default now()
);
