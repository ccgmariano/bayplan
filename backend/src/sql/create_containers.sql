create table if not exists containers (
  id serial primary key,
  workset_id integer not null references worksets(id) on delete cascade,

  container_no text not null,
  iso_type text,

  bay integer,
  row integer,
  tier integer,
  area text check (area in ('DECK','HOLD')),

  status text not null default 'PENDING' check (status in ('PENDING','DONE')),
  done_at timestamptz,

  created_at timestamptz not null default now(),

  unique (workset_id, container_no)
);

create index if not exists idx_containers_workset_bay_area on containers (workset_id, bay, area);
